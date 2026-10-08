"use strict";

const fs = require("fs");
const path = require("path");
const { isMainThread, parentPort, workerData } = require("worker_threads");
const { DatabaseSync } = require("node:sqlite");
const {
  buildChangedThreadQuery,
  buildThreadQuery,
  extractUnreadState,
  unreadIdentityKey
} = require("./codex-state");

const TRANSCRIPT_TAIL_BYTES = 512_000;
const MAX_TRANSCRIPT_CACHE = 240;
const FULL_DATABASE_REFRESH_MS = 60_000;
// Codex writes `turn_aborted` when an in-flight task is interrupted. Keep the
// small compatibility set here because older/newer clients may use a closely
// related terminal name. These are terminal observations only; they do not
// turn an interrupted task into a successful completion notification.
const TERMINAL_TURN_EVENT_TYPES = new Set([
  "turn_aborted",
  "turn_cancelled",
  "turn_canceled",
  "turn_failed",
  "turn_interrupted",
  "turn_paused",
  "turn_stopped",
  "task_aborted",
  "task_cancelled",
  "task_canceled",
  "task_failed",
  "task_interrupted",
  "task_paused",
  "task_stopped"
]);

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1_000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyObservation() {
  return {
    latestProgress: "",
    latestProgressAt: 0,
    latestStartedAt: 0,
    latestCompletedAt: 0,
    latestTerminalAt: 0,
    latestRateLimits: null,
    latestRateLimitsAt: 0,
    isRunning: false
  };
}

function updateObservation(observation, line) {
  if (!line) return;
  let root;
  try {
    root = JSON.parse(line);
  } catch {
    return;
  }
  const timestamp = parseTimestamp(root.timestamp);
  const payload = root.payload || {};
  const payloadType = payload.type;
  const terminalTimestamp = Math.max(
    timestamp,
    parseTimestamp(payload.completed_at),
    parseTimestamp(payload.completedAt),
    parseTimestamp(payload.ended_at),
    parseTimestamp(payload.endedAt)
  );
  if (root.type === "turn_context") {
    // A long-running turn can grow beyond the initial transcript tail and
    // push its original task_started record out of view. Codex writes a new
    // turn_context after compaction, so it is valid fresh evidence that the
    // current turn is still open until a later task_complete appears.
    observation.latestStartedAt = Math.max(
      observation.latestStartedAt,
      timestamp
    );
    return;
  }
  if (root.type === "event_msg") {
    if (
      payloadType === "token_count"
      && payload.info?.rate_limits
      && timestamp >= observation.latestRateLimitsAt
    ) {
      observation.latestRateLimits = payload.info.rate_limits;
      observation.latestRateLimitsAt = timestamp;
    } else if (payloadType === "task_started") {
      observation.latestStartedAt = Math.max(
        observation.latestStartedAt,
        timestamp
      );
    } else if (payloadType === "task_complete") {
      observation.latestCompletedAt = Math.max(
        observation.latestCompletedAt,
        terminalTimestamp
      );
      observation.latestTerminalAt = Math.max(
        observation.latestTerminalAt,
        terminalTimestamp
      );
      if (
        typeof payload.last_agent_message === "string"
        && terminalTimestamp >= observation.latestProgressAt
      ) {
        observation.latestProgress = payload.last_agent_message;
        observation.latestProgressAt = terminalTimestamp;
      }
    } else if (TERMINAL_TURN_EVENT_TYPES.has(payloadType)) {
      // An interrupted, paused, cancelled or failed turn is no longer running.
      // Keep its latest progress for display, but do not set `latestCompletedAt`
      // because it is not a successful task completion and must not trigger a
      // "任务已完成" notification.
      observation.latestTerminalAt = Math.max(
        observation.latestTerminalAt,
        terminalTimestamp
      );
    } else if (
      payloadType === "agent_message"
      && typeof payload.message === "string"
      && timestamp >= observation.latestProgressAt
    ) {
      observation.latestProgress = payload.message;
      observation.latestProgressAt = timestamp;
    } else if (
      payloadType === "agent_reasoning"
      && typeof payload.text === "string"
      && timestamp >= observation.latestProgressAt
    ) {
      observation.latestProgress = payload.text;
      observation.latestProgressAt = timestamp;
    }
    return;
  }
  if (
    root.type === "response_item"
    && payloadType === "message"
    && payload.role === "assistant"
    && Array.isArray(payload.content)
  ) {
    const message = payload.content
      .map((item) => typeof item?.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
    if (message && timestamp >= observation.latestProgressAt) {
      observation.latestProgress = message;
      observation.latestProgressAt = timestamp;
    }
  }
}

function finalizeObservation(observation) {
  const terminalAt = Math.max(
    observation.latestCompletedAt,
    observation.latestTerminalAt
  );
  // A new `task_started` / `turn_context` after a terminal event opens a new
  // turn. Progress alone is deliberately not allowed to reopen a terminated
  // turn: Codex may append final text after `turn_aborted`, and treating that
  // text as active was the source of stale "进行中" tasks.
  observation.isRunning = observation.latestStartedAt > terminalAt
    || (terminalAt === 0 && observation.latestProgressAt > 0);
  return observation;
}

class IncrementalTranscriptReader {
  constructor({ maxTailBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
    this.maxTailBytes = maxTailBytes;
    this.cache = new Map();
  }

  read(filePath) {
    try {
      const stats = fs.statSync(filePath);
      const cached = this.cache.get(filePath);
      const sameFile = cached
        && cached.dev === stats.dev
        && cached.ino === stats.ino
        && stats.size >= cached.offset;
      if (
        sameFile
        && stats.size === cached.offset
        && stats.mtimeMs === cached.mtimeMs
      ) {
        return cached.observation;
      }
      if (!sameFile) return this.readTail(filePath, stats);
      return this.readAppend(filePath, stats, cached);
    } catch {
      this.cache.delete(filePath);
      return emptyObservation();
    }
  }

  readTail(filePath, stats) {
    const start = Math.max(0, stats.size - this.maxTailBytes);
    const buffer = this.readRange(filePath, start, stats.size);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    const observation = emptyObservation();
    const endsWithNewline = text.endsWith("\n");
    const lines = text.split("\n");
    const carry = endsWithNewline ? "" : lines.pop() || "";
    for (const line of lines) updateObservation(observation, line);
    // JSONL writers normally terminate records with a newline. If the current
    // final record is already valid JSON, include it now and clear the carry;
    // otherwise keep it for the next append event.
    let nextCarry = carry;
    if (carry) {
      const before = JSON.stringify(observation);
      updateObservation(observation, carry);
      if (JSON.stringify(observation) !== before) nextCarry = "";
    }
    const entry = {
      dev: stats.dev,
      ino: stats.ino,
      offset: stats.size,
      mtimeMs: stats.mtimeMs,
      carry: nextCarry,
      observation: finalizeObservation(observation)
    };
    this.cache.set(filePath, entry);
    return entry.observation;
  }

  readAppend(filePath, stats, cached) {
    const buffer = this.readRange(filePath, cached.offset, stats.size);
    const text = cached.carry + buffer.toString("utf8");
    const endsWithNewline = text.endsWith("\n");
    const lines = text.split("\n");
    const carry = endsWithNewline ? "" : lines.pop() || "";
    for (const line of lines) updateObservation(cached.observation, line);
    let nextCarry = carry;
    if (carry) {
      const before = JSON.stringify(cached.observation);
      updateObservation(cached.observation, carry);
      if (JSON.stringify(cached.observation) !== before) nextCarry = "";
    }
    cached.offset = stats.size;
    cached.mtimeMs = stats.mtimeMs;
    cached.carry = nextCarry;
    finalizeObservation(cached.observation);
    return cached.observation;
  }

  readRange(filePath, start, end) {
    const length = Math.max(0, end - start);
    if (length === 0) return Buffer.alloc(0);
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(handle, buffer, 0, length, start);
      return buffer;
    } finally {
      fs.closeSync(handle);
    }
  }

  prune(keepPaths) {
    if (this.cache.size <= MAX_TRANSCRIPT_CACHE) return;
    for (const filePath of this.cache.keys()) {
      if (!keepPaths.has(filePath)) this.cache.delete(filePath);
      if (this.cache.size <= MAX_TRANSCRIPT_CACHE) break;
    }
  }
}

class TaskDataReader {
  constructor({ codexHome, globalStatePath }) {
    this.codexHome = codexHome;
    this.globalStatePath = globalStatePath;
    this.databasePath = null;
    this.database = null;
    this.databaseIdentity = null;
    this.columns = [];
    this.transcripts = new IncrementalTranscriptReader();
    this.rowsById = new Map();
    this.updatedCursor = 0;
    this.lastFullRefreshAt = 0;
    this.lastUnreadSignature = "";
  }

  close() {
    try {
      this.database?.close();
    } catch {
    }
    this.database = null;
    this.databasePath = null;
    this.databaseIdentity = null;
    this.columns = [];
    this.rowsById.clear();
    this.updatedCursor = 0;
    this.lastFullRefreshAt = 0;
    this.lastUnreadSignature = "";
  }

  resolveStateDatabasePath() {
    let names = [];
    try {
      names = fs.readdirSync(this.codexHome);
    } catch {
    }
    const candidates = names
      .map((name) => {
        const match = /^state_(\d+)\.sqlite$/i.exec(name);
        if (!match) return null;
        const filePath = path.join(this.codexHome, name);
        try {
          const stats = fs.statSync(filePath);
          return {
            filePath,
            version: Number(match[1]),
            dev: stats.dev,
            ino: stats.ino
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.version - a.version);
    return candidates[0] || {
      filePath: path.join(this.codexHome, "state_5.sqlite"),
      dev: 0,
      ino: 0
    };
  }

  ensureDatabase() {
    const candidate = this.resolveStateDatabasePath();
    const identity = `${candidate.filePath}:${candidate.dev}:${candidate.ino}`;
    if (this.database && this.databaseIdentity === identity) return;
    this.close();
    this.databasePath = candidate.filePath;
    this.databaseIdentity = identity;
    this.database = new DatabaseSync(candidate.filePath, {
      readOnly: true,
      timeout: 2_000
    });
    this.columns = this.database
      .prepare("PRAGMA table_info(threads);")
      .all()
      .map((row) => row?.name)
      .filter((name) => typeof name === "string");
  }

  readUnreadState() {
    try {
      const root = JSON.parse(fs.readFileSync(this.globalStatePath, "utf8"));
      let auth = null;
      // Older Codex versions need no account selector. For the scoped format,
      // a missing selector is unavailable, not an empty / viewed unread set.
      if (Object.hasOwn(root, "electron-thread-read-state-v1")) {
        try {
          auth = JSON.parse(fs.readFileSync(path.join(this.codexHome, "auth.json"), "utf8"));
        } catch {}
      }
      return extractUnreadState(root, { identityKey: unreadIdentityKey(auth) });
    } catch {
      return { ids: [], available: false };
    }
  }

  refresh() {
    const startedAt = Date.now();
    const unread = this.readUnreadState();
    this.ensureDatabase();
    const unreadSignature = unread.ids.slice().sort().join("\n");
    const fullRefresh = this.rowsById.size === 0
      || Date.now() - this.lastFullRefreshAt >= FULL_DATABASE_REFRESH_MS
      || unreadSignature !== this.lastUnreadSignature;
    let queryMode = "incremental";
    let changedRowCount = 0;
    if (fullRefresh) {
      const sql = buildThreadQuery(this.columns, unread.ids, 120);
      const rows = sql ? this.database.prepare(sql).all() : [];
      this.rowsById.clear();
      for (const row of rows) {
        if (!row?.id || Number(row.archived || 0) !== 0) continue;
        this.rowsById.set(row.id, row);
      }
      this.updatedCursor = rows.reduce(
        (latest, row) => Math.max(latest, Number(row.updated_at_ms || 0)),
        0
      );
      this.lastFullRefreshAt = Date.now();
      this.lastUnreadSignature = unreadSignature;
      queryMode = "full";
      changedRowCount = rows.length;
    } else {
      const sql = buildChangedThreadQuery(
        this.columns,
        this.updatedCursor,
        500
      );
      const changedRows = sql ? this.database.prepare(sql).all() : [];
      for (const row of changedRows) {
        if (!row?.id) continue;
        this.updatedCursor = Math.max(
          this.updatedCursor,
          Number(row.updated_at_ms || 0)
        );
        if (Number(row.archived || 0) !== 0) {
          this.rowsById.delete(row.id);
        } else {
          this.rowsById.set(row.id, row);
        }
      }
      changedRowCount = changedRows.length;
    }
    const rows = [...this.rowsById.values()].sort(
      (a, b) => Number(b.recency_at_ms || 0) - Number(a.recency_at_ms || 0)
    );
    const keepPaths = new Set();
    let latestRateLimits = null;
    let latestRateLimitsAt = 0;
    for (const row of rows) {
      const filePath = typeof row.rollout_path === "string"
        ? row.rollout_path
        : "";
      if (filePath) keepPaths.add(filePath);
      row.observation = filePath
        ? this.transcripts.read(filePath)
        : emptyObservation();
      if (row.observation.latestRateLimitsAt > latestRateLimitsAt) {
        latestRateLimits = row.observation.latestRateLimits;
        latestRateLimitsAt = row.observation.latestRateLimitsAt;
      }
    }
    this.transcripts.prune(keepPaths);
    return {
      unread,
      rows,
      rateLimits: latestRateLimits,
      rateLimitsAt: latestRateLimitsAt,
      databasePath: this.databasePath,
      durationMs: Date.now() - startedAt,
      queryMode,
      changedRowCount,
      transcriptCacheSize: this.transcripts.cache.size
    };
  }
}

if (!isMainThread) {
  const reader = new TaskDataReader(workerData);
  parentPort.on("message", (message) => {
    if (message?.type === "close") {
      reader.close();
      process.exit(0);
      return;
    }
    if (message?.type !== "refresh" || !message.id) return;
    try {
      parentPort.postMessage({
        id: message.id,
        result: reader.refresh()
      });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

module.exports = {
  IncrementalTranscriptReader,
  TaskDataReader,
  emptyObservation,
  updateObservation
};

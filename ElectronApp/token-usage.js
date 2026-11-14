"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isTopLevelThread } = require("./task-classification");

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const BLOCK = 256 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_EVENTS = 200_000;
const MAX_CACHE_BYTES = 10 * 1024 * 1024;
const SLICE_BYTES = 8 * 1024 * 1024;
const SLICE_MS = 20;
const TOKEN = Buffer.from('"token_count"');
const LF = 10;
const EMPTY = Buffer.alloc(0);
const safeCount = n => Number.isSafeInteger(n) && n >= 0;
const digest = value => createHash("sha256").update(value).digest("hex");
const count = usage => {
  if (safeCount(usage?.total_tokens)) return usage.total_tokens;
  const { input_tokens: input, output_tokens: output } = usage || {};
  return safeCount(input) && safeCount(output) && safeCount(input + output) ? input + output : null;
};

function usageEvent(line, now) {
  if (!line.includes(TOKEN)) return null;
  let root;
  try { root = JSON.parse(line.toString("utf8")); } catch { return { at: now, invalid: true }; }
  if (root?.type !== "event_msg" || root.payload?.type !== "token_count") return null;
  const info = root.payload.info;
  if (!info) return null;
  const stamp = root.timestamp;
  const at = typeof stamp === "number" ? (stamp < 1e12 ? stamp * 1000 : stamp) : Date.parse(stamp);
  const total = count(info.total_token_usage);
  if (!Number.isFinite(at) || at <= 0 || at > now || total === null) {
    return { at: Number.isFinite(at) && at > 0 ? Math.min(at, now) : now, invalid: true };
  }
  return { at, total, last: count(info.last_token_usage) };
}

function usageThreadQuery(columns) {
  const has = name => columns.includes(name);
  if (!has("id") || !has("rollout_path")) return null;
  const updated = has("updated_at_ms") && has("updated_at")
    ? "COALESCE(NULLIF(updated_at_ms, 0), updated_at * 1000, 0)"
    : has("updated_at_ms") ? "updated_at_ms" : has("updated_at") ? "updated_at * 1000" : "0";
  // No task-list LIMIT or archived filter. Only metadata, not titles/text.
  const fields = ["thread_source", "source", "parent_thread_id", "attached_thread_parent_id"]
    .filter(has);
  return `SELECT id, rollout_path, ${updated} AS updated_at_ms${fields.length ? ", " + fields.join(", ") : ""} FROM threads`;
}

class UsageSession {
  constructor(file, stats, recent) {
    this.file = file;
    this.dev = stats.dev;
    this.ino = stats.ino;
    this.size = stats.size;
    this.mtimeMs = stats.mtimeMs;
    this.recent = recent;
    this.reverse = stats.size;
    this.forward = stats.size;
    this.reverseCarry = EMPTY;
    this.forwardCarry = EMPTY;
    this.reverseDiscard = false;
    this.forwardDiscard = false;
    this.tailPending = stats.size > 0;
    this.latest = null;
    this.newer = null;
    this.reverseBroken = false;
    this.forwardBroken = false;
    this.life = 0;
    this.gapAt = 0;
    this.lifeGap = false;
    this.rollingReady = stats.size === 0;
    this.lifeReady = stats.size === 0;
    this.events = [];
    this.dayHead = 0;
    this.weekHead = 0;
    this.day = 0;
    this.week = 0;
    this.failed = false;
  }

  gap(at) {
    this.lifeGap = true;
    this.gapAt = Math.max(this.gapAt, at);
  }

  add(at, delta, now, index, backwards) {
    if (!safeCount(delta) || !safeCount(this.life + delta)) { this.gap(at); return; }
    this.life += delta;
    if (!delta || !this.recent || at <= now - WEEK) return;
    if (index.eventCount >= MAX_EVENTS) { this.gap(at); return; }
    this.events.push({ at, delta });
    index.eventCount++;
    if (!backwards) {
      this.week += delta;
      if (at > now - DAY) this.day += delta;
      else if (this.dayHead === this.events.length - 1) this.dayHead++;
    }
  }

  consume(line, now, index, backwards) {
    if (line.length > MAX_LINE) {
      if (line.subarray(0, 1024).includes(TOKEN)) {
        this.gap(now);
        if (backwards) this.reverseBroken = true; else this.forwardBroken = true;
      }
      return;
    }
    const item = usageEvent(line, now);
    if (!item) return;
    if (item.invalid) {
      this.gap(item.at);
      if (backwards) this.reverseBroken = true; else this.forwardBroken = true;
      return;
    }
    if (backwards) {
      if (!this.latest) this.latest = item;
      if (this.newer) {
        if (item.at > this.newer.at) { this.gap(item.at); return; }
        if (item.total > this.newer.total) this.gap(this.newer.at);
        else if (!this.reverseBroken) this.add(this.newer.at, this.newer.total - item.total, now, index, true);
      }
      this.newer = item;
      this.reverseBroken = false;
      // Retain one preceding counter as the exact rolling-window baseline.
      if (!this.rollingReady && item.at <= now - WEEK) this.finishRolling(now, index);
      return;
    }
    const prior = this.latest;
    if (prior && item.at < prior.at) { this.gap(prior.at); return; }
    if (!prior) this.first(item, now, index, false, this.forwardBroken);
    else if (item.total < prior.total) this.gap(item.at);
    else if (!this.forwardBroken) this.add(item.at, item.total - prior.total, now, index, false);
    this.forwardBroken = false;
    this.latest = item;
  }

  first(item, now, index, backwards, broken) {
    // A resumed/truncated file may start with a large inherited cumulative
    // count. Only the independently reported increment is attributable.
    if (broken || item.last === null || item.last > item.total) {
      if (item.total !== 0 || broken) this.gap(item.at);
      return;
    }
    if (item.last !== item.total) this.gap(item.at);
    this.add(item.at, item.last, now, index, backwards);
  }

  finishRolling(now, index) {
    this.events.reverse();
    this.week = this.events.reduce((sum, e) => sum + e.delta, 0);
    this.day = this.week;
    this.rollingReady = true;
    this.expire(now, index);
  }

  expire(now, index) {
    while (this.dayHead < this.events.length && this.events[this.dayHead].at <= now - DAY) {
      this.day -= this.events[this.dayHead++].delta;
    }
    while (this.weekHead < this.events.length && this.events[this.weekHead].at <= now - WEEK) {
      this.week -= this.events[this.weekHead++].delta;
    }
    if (this.weekHead && (this.weekHead >= 256 || this.weekHead === this.events.length)) {
      this.events = this.events.slice(this.weekHead);
      index.eventCount -= this.weekHead;
      this.dayHead -= this.weekHead;
      this.weekHead = 0;
    }
  }

  reverseBlock(bytes, now, index, needLife) {
    let end = bytes.length;
    if (this.tailPending) {
      this.tailPending = false;
      const lastLF = bytes.lastIndexOf(LF);
      if (lastLF !== end - 1) {
        const tail = bytes.subarray(lastLF + 1);
        // Count a final complete JSON record even without a newline; keep
        // an unfinished writer record for the forward pass instead.
        let complete = false;
        if (lastLF >= 0 || !this.reverse) {
          if (tail.length <= MAX_LINE) {
            try { JSON.parse(tail.toString("utf8")); complete = true; } catch {}
          }
        }
        if (!complete) {
          this.forwardCarry = tail.length <= MAX_LINE ? Buffer.from(tail) : EMPTY;
          this.forwardDiscard = tail.length > MAX_LINE || lastLF < 0 && this.reverse > 0;
          end = lastLF + 1;
          // The last LF was outside this block; drop the rest of that
          // unfinished record while walking backwards.
          if (end === 0 && this.reverse) this.reverseDiscard = true;
        }
      }
    }
    while (end > 0) {
      const lf = bytes.lastIndexOf(LF, end - 1);
      if (lf < 0) {
        const part = bytes.subarray(0, end);
        if (!this.reverseDiscard && part.length + this.reverseCarry.length <= MAX_LINE) {
          this.reverseCarry = Buffer.concat([part, this.reverseCarry]);
        } else {
          if (part.subarray(0, 1024).includes(TOKEN)) this.gap(now);
          this.reverseCarry = EMPTY;
          this.reverseDiscard = true;
        }
        break;
      }
      const part = bytes.subarray(lf + 1, end);
      if (!this.reverseDiscard) {
        this.consume(this.reverseCarry.length ? Buffer.concat([part, this.reverseCarry]) : part, now, index, true);
      } else if (part.subarray(0, 1024).includes(TOKEN)) this.gap(now);
      this.reverseCarry = EMPTY;
      this.reverseDiscard = false;
      end = lf;
      // Keep the unconsumed prefix for a later lifetime pass. Its end is
      // already a record boundary, so no carry or duplicate count is needed.
      if (this.rollingReady && !needLife && this.reverse + end > 0) {
        this.reverse += end;
        return;
      }
    }
    if (!this.reverse) {
      if (!this.reverseDiscard) this.consume(this.reverseCarry, now, index, true);
      if (this.newer) this.first(this.newer, now, index, true, this.reverseBroken);
      this.reverseCarry = EMPTY;
      if (!this.rollingReady) this.finishRolling(now, index);
      this.lifeReady = true;
    }
  }

  forwardBlock(bytes, now, index) {
    let from = 0;
    for (let lf; (lf = bytes.indexOf(LF, from)) >= 0; from = lf + 1) {
      const part = bytes.subarray(from, lf);
      if (!this.forwardDiscard) this.consume(this.forwardCarry.length
        ? Buffer.concat([this.forwardCarry, part]) : part, now, index, false);
      this.forwardCarry = EMPTY;
      this.forwardDiscard = false;
    }
    const tail = bytes.subarray(from);
    if (!this.forwardDiscard && tail.length + this.forwardCarry.length <= MAX_LINE) {
      this.forwardCarry = Buffer.concat([this.forwardCarry, tail]);
      // The next append may supply only the missing newline.
      if (this.forward === this.size && this.forwardCarry.includes(TOKEN)) {
        let complete = false;
        try { JSON.parse(this.forwardCarry.toString("utf8")); complete = true; } catch {}
        if (complete) {
          this.consume(this.forwardCarry, now, index, false);
          this.forwardCarry = EMPTY;
        }
      }
    } else {
      if (this.forwardCarry.subarray(0, 1024).includes(TOKEN)
          || tail.subarray(0, 1024).includes(TOKEN)) this.gap(now);
      this.forwardCarry = EMPTY;
      this.forwardDiscard = true;
    }
  }

  step(index, now, needLife, budget) {
    const backwards = !this.rollingReady || (this.forward >= this.size && needLife && !this.lifeReady);
    const end = backwards ? this.reverse : Math.min(this.size, this.forward + Math.min(BLOCK, budget));
    const start = backwards ? Math.max(0, end - Math.min(BLOCK, budget)) : this.forward;
    if (end <= start) return 0;
    const bytes = Buffer.allocUnsafe(end - start);
    let fd;
    try {
      fd = fs.openSync(this.file, "r");
      const st = fs.fstatSync(fd);
      if (st.ino !== this.ino || st.dev !== this.dev || st.size < end) throw Error("changed source");
      const read = fs.readSync(fd, bytes, 0, bytes.length, start);
      if (read !== bytes.length) throw Error("short read");
      if (backwards) { this.reverse = start; this.reverseBlock(bytes, now, index, needLife); }
      else { this.forward = end; this.forwardBlock(bytes, now, index); }
      return read;
    } catch {
      this.failed = true;
      this.gap(now);
      return 0;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}

const display = (value, loading, partial, known = true) => ({
  value: loading || !known ? null : value,
  state: loading ? "loading" : partial ? "partial" : known ? "ready" : "unavailable"
});

function boundaryDigest(file, size) {
  const length = Math.min(size, 96);
  if (!length) return digest(EMPTY);
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const bytes = Buffer.allocUnsafe(length);
    return fs.readSync(fd, bytes, 0, length, size - length) === length ? digest(bytes) : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

class UsageIndex {
  constructor(codexHome, cachePath = null) {
    this.root = path.resolve(codexHome);
    try { this.realRoot = fs.realpathSync(this.root); } catch { this.realRoot = this.root; }
    this.entries = new Map();
    this.rows = new Map();
    this.priorities = new Set();
    this.aliases = new Map();
    this.eventCount = 0;
    this.discoveredAt = -Infinity;
    this.available = false;
    this.turn = 0;
    this.cachePath = cachePath;
    this.cacheScope = digest(this.realRoot);
    this.saved = this.readCache();
    this.lastSavedAt = 0;
    this.savedPending = false;
    this.dirty = false;
  }

  readCache() {
    if (!this.cachePath) return null;
    try {
      if (fs.statSync(this.cachePath).size > MAX_CACHE_BYTES) return null;
      const data = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      return data.version === 1 && data.scope === this.cacheScope && Array.isArray(data.entries)
        ? new Map(data.entries) : null;
    } catch { return null; }
  }

  restore(id, file, st, recent, now) {
    const saved = this.saved?.get(id);
    const validEvent = e => e === null || (safeCount(e?.at) && safeCount(e?.total)
      && (e.last === null || safeCount(e.last)));
    if (!saved || saved.dev !== st.dev || saved.ino !== st.ino
        || !safeCount(saved.size) || saved.size > st.size
        || (saved.size === st.size && saved.mtimeMs !== st.mtimeMs)
        || !safeCount(saved.reverse) || saved.reverse > saved.size
        || !safeCount(saved.life) || !safeCount(saved.gapAt)
        || !validEvent(saved.latest) || !validEvent(saved.newer)
        || !Array.isArray(saved.events) || saved.events.length + this.eventCount > MAX_EVENTS
        || !saved.anchor || boundaryDigest(file, saved.size) !== saved.anchor) return null;
    const events = [];
    let prior = 0;
    for (const item of saved.events) {
      if (!Array.isArray(item) || !safeCount(item[0]) || !safeCount(item[1])
          || item[0] < prior || item[0] > now) return null;
      prior = item[0];
      if (prior > now - WEEK) events.push({ at: prior, delta: item[1] });
    }
    const e = new UsageSession(file, st, recent);
    Object.assign(e, {
      reverse: saved.reverse, forward: saved.size, tailPending: false,
      latest: saved.latest, newer: saved.newer, life: saved.life, lifeReady: saved.lifeReady === true,
      gapAt: saved.gapAt, lifeGap: saved.lifeGap === true,
      reverseBroken: saved.reverseBroken === true, forwardBroken: saved.forwardBroken === true,
      rollingReady: true, events
    });
    this.eventCount += events.length;
    e.week = events.reduce((n, item) => n + item.delta, 0);
    e.day = e.week;
    e.expire(now, this);
    return e;
  }

  save(now, pending) {
    if (!this.cachePath || !this.dirty
        || (now - this.lastSavedAt < 120_000 && !(this.savedPending && !pending))) return;
    const entries = [];
    for (const [id, e] of this.entries) {
      if (!e.rollingReady || e.failed || e.forward !== e.size
          || e.forwardCarry.length || e.reverseCarry.length || e.forwardDiscard || e.reverseDiscard) continue;
      const anchor = boundaryDigest(e.file, e.size);
      if (!anchor) continue;
      const { dev, ino, size, mtimeMs, reverse, latest, newer, life, lifeReady,
        gapAt, lifeGap, reverseBroken, forwardBroken } = e;
      entries.push([id, { dev, ino, size, mtimeMs, reverse, latest, newer, life, lifeReady,
        gapAt, lifeGap, reverseBroken, forwardBroken, anchor,
        events: e.events.slice(e.weekHead).map(({at, delta}) => [at, delta]) }]);
    }
    this.lastSavedAt = now;
    this.savedPending = pending;
    try {
      const data = JSON.stringify({ version: 1, scope: this.cacheScope, entries });
      if (Buffer.byteLength(data) > MAX_CACHE_BYTES) return;
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const temporary = this.cachePath + ".tmp";
      fs.writeFileSync(temporary, data, { mode: 0o600 });
      fs.renameSync(temporary, this.cachePath);
      this.dirty = false;
    } catch {}
  }

  discover(db, columns, now) {
    const sql = usageThreadQuery(columns);
    this.available = Boolean(sql);
    if (!sql) return;
    const next = new Map();
    for (const row of db.prepare(sql).iterate()) {
      if (!row.id || row.attached_thread_parent_id || !isTopLevelThread(row)) continue;
      next.set(row.id, row);
    }
    this.rows = next;
    this.aliases.clear();
    for (const [id, entry] of this.entries) {
      if (!next.has(id)) this.discard(id, entry);
    }
    for (const [id, row] of next) this.reconcile(id, row, now);
    this.saved = null;
    // A legacy path alias can reference the same inode. Keep one ledger.
    const physical = new Map();
    for (const [id, entry] of this.entries) {
      if (!entry.file) continue;
      const key = `${entry.dev}:${entry.ino}`;
      if (physical.has(key)) {
        const previous = physical.get(key);
        if (this.priorities.has(id) && !this.priorities.has(previous)) {
          this.discard(previous, this.entries.get(previous));
          this.aliases.set(previous, id);
          physical.set(key, id);
        } else {
          this.discard(id, entry);
          this.aliases.set(id, previous);
        }
      } else physical.set(key, id);
    }
    this.discoveredAt = now;
  }

  discard(id, entry) {
    if (entry?.events) this.eventCount -= entry.events.length;
    this.entries.delete(id);
  }

  reconcile(id, row, now) {
    let entry = this.entries.get(id);
    const selected = this.priorities.has(id);
    const updated = Number(row.updated_at_ms || 0);
    const file = typeof row.rollout_path === "string" ? path.resolve(row.rollout_path) : "";
    const within = (file, root) => file.startsWith(root + path.sep);
    try {
      if (!file || (!within(file, this.root) && !within(file, this.realRoot))) throw Error("outside source");
      const actual = fs.realpathSync(file);
      if (!within(actual, this.realRoot)) throw Error("outside source");
      const stats = fs.statSync(actual);
      if (!stats.isFile()) throw Error("not a file");
      const recent = Math.max(updated, stats.mtimeMs) > now - WEEK;
      if (!recent && !selected) {
        // Keep previously completed lifetime counters while their rolling
        // events expire; never rescan an unchanged historical file.
        if (entry?.rollingReady) { entry.recent = false; return; }
        this.discard(id, entry); return;
      }
      if (!entry?.file || entry.dev !== stats.dev || entry.ino !== stats.ino
          || stats.size < entry.size || (stats.size === entry.size && stats.mtimeMs !== entry.mtimeMs)
          || entry.failed) {
        this.discard(id, entry);
        entry = this.restore(id, actual, stats, recent, now) || new UsageSession(actual, stats, recent);
        this.entries.set(id, entry);
      } else {
        entry.file = actual;
        entry.size = stats.size;
        entry.mtimeMs = stats.mtimeMs;
        entry.recent = recent;
      }
    } catch {
      this.discard(id, entry);
      if (selected || updated > now - WEEK) this.entries.set(id, { missing: true, updated, recent: updated > now - WEEK });
    }
  }

  read(db, columns, ids = [], { recheck = false, now = Date.now(), budget = SLICE_BYTES } = {}) {
    const canonical = (id) => {
      while (this.aliases.has(id)) id = this.aliases.get(id);
      return id;
    };
    this.priorities = new Set(ids.map(canonical));
    if (!this.available || recheck && now - this.discoveredAt >= 60_000) this.discover(db, columns, now);
    else if (recheck) {
      // The existing live refresh reports active/visible IDs. Use its
      // cadence; no extra all-source poll is introduced here.
      for (const id of this.priorities) {
        const row = this.rows.get(id);
        if (row) this.reconcile(id, row, now);
        else { this.discover(db, columns, now); break; }
      }
    }
    this.priorities = new Set(ids.map(canonical));
    const entries = [...this.entries.entries()];
    for (const [, e] of entries) if (e.rollingReady) e.expire(now, this);
    const rolling = entries.filter(([, e]) => e.file && !e.failed && (!e.rollingReady || e.forward < e.size));
    const recent = rolling.filter(([, e]) => e.recent);
    const other = rolling.filter(([, e]) => !e.recent);
    const life = entries.filter(([id, e]) => this.priorities.has(id) && e.file && !e.failed && e.rollingReady && !e.lifeReady);
    let readBytes = 0;
    const until = performance.now() + SLICE_MS;
    const jobs = recent.length ? recent : [...other, ...life];
    // One block per turn across files, so one huge log cannot starve the
    // rest of the window. Time and bytes are bounded independently.
    while (jobs.length && readBytes < budget && performance.now() < until) {
      const i = this.turn++ % jobs.length;
      const [id, e] = jobs[i];
      const used = e.step(this, Date.now(), !recent.length && this.priorities.has(id), budget - readBytes);
      readBytes += used;
      if (!used || (e.rollingReady && e.forward >= e.size && (recent.length || e.lifeReady))) jobs.splice(i, 1);
    }
    const sessions = Object.create(null);
    let day = 0, week = 0, dayPartial = false, weekPartial = false, loading = false;
    let nextExpiry = Infinity, pending = false;
    for (const [id, e] of entries) {
      const wanted = this.priorities.has(id);
      if (e.missing) {
        if (e.recent) { weekPartial = true; dayPartial ||= e.updated > now - DAY; }
        if (wanted) sessions[id] = display(0, false, true, false);
        continue;
      }
      const unprocessed = !e.failed && (!e.rollingReady || e.forward < e.size);
      pending ||= unprocessed || (wanted && !e.failed && !e.lifeReady);
      if (e.recent) {
        loading ||= unprocessed;
        day += e.day;
        week += e.week;
        dayPartial ||= e.gapAt > now - DAY;
        weekPartial ||= e.gapAt > now - WEEK;
        nextExpiry = Math.min(nextExpiry,
          (e.events[e.dayHead]?.at ?? Infinity) + DAY,
          (e.events[e.weekHead]?.at ?? Infinity) + WEEK,
          e.gapAt > now - DAY ? e.gapAt + DAY : Infinity,
          e.gapAt > now - WEEK ? e.gapAt + WEEK : Infinity);
      }
      if (wanted) sessions[id] = display(e.life,
        !e.failed && (!e.lifeReady || e.forward < e.size), e.lifeGap, !e.lifeGap || e.life > 0);
    }
    for (const id of ids) sessions[id] = sessions[canonical(id)] || display(0, false, false, false);
    this.dirty ||= readBytes > 0;
    if (!loading) this.save(now, pending);
    return {
      day: display(day, loading, dayPartial, this.available && (!dayPartial || day > 0)),
      week: display(week, loading, weekPartial, this.available && (!weekPartial || week > 0)),
      sessions, pending, readBytes, nextExpiry: Number.isFinite(nextExpiry) ? nextExpiry : null
    };
  }
}

module.exports = { UsageIndex, UsageSession, usageEvent, usageThreadQuery, DAY, WEEK, SLICE_BYTES };

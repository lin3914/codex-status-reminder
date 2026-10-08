"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { isActiveRuntimeStatus } = require("./task-classification");

const INITIAL_CLIENT_ID = "initializing-client";
const IPC_VERSION = {
  "thread-owner-discovery": 1,
  "thread-stream-following-changed": 1,
  "thread-stream-state-changed": 11
};
const STATUS_REVALIDATION_MS = 30_000;
const UNAVAILABLE_RETRY_MS = 8_000;
const ACTIVE_FAILURE_GRACE_MS = 30_000;
const STATUS_RETENTION_MS = 10 * 60_000;
const MAX_CANDIDATES_PER_REFRESH = 24;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

class LengthPrefixedFrameDecoder {
  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
    this.chunks = [];
    this.headOffset = 0;
    this.length = 0;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  clear() {
    this.chunks = [];
    this.headOffset = 0;
    this.length = 0;
  }

  peekUInt32LE() {
    if (this.length < 4) return null;
    const first = this.chunks[0];
    if (first.length - this.headOffset >= 4) {
      return first.readUInt32LE(this.headOffset);
    }
    const header = this.copy(4, false);
    return header.readUInt32LE(0);
  }

  read(size) {
    if (size < 0 || this.length < size) return null;
    return this.copy(size, true);
  }

  copy(size, consume) {
    const first = this.chunks[0];
    if (first && first.length - this.headOffset >= size) {
      const value = first.subarray(this.headOffset, this.headOffset + size);
      if (consume) this.consume(size);
      return value;
    }
    const value = Buffer.allocUnsafe(size);
    let copied = 0;
    let chunkIndex = 0;
    let offset = this.headOffset;
    while (copied < size) {
      const chunk = this.chunks[chunkIndex];
      const available = Math.min(chunk.length - offset, size - copied);
      chunk.copy(value, copied, offset, offset + available);
      copied += available;
      chunkIndex += 1;
      offset = 0;
    }
    if (consume) this.consume(size);
    return value;
  }

  consume(size) {
    let remaining = size;
    this.length -= size;
    while (remaining > 0) {
      const first = this.chunks[0];
      const available = first.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        return;
      }
      remaining -= available;
      this.chunks.shift();
      this.headOffset = 0;
    }
  }

  nextFrame() {
    const length = this.peekUInt32LE();
    if (length === null) return null;
    if (length <= 0 || length > this.maxFrameBytes) {
      const error = new Error(`Codex IPC frame exceeds limit: ${length}`);
      error.code = "IPC_FRAME_LIMIT";
      throw error;
    }
    if (this.length < length + 4) return null;
    this.consume(4);
    return this.read(length);
  }
}

class CodexIpcStatusClient {
  constructor({
    socketPath = path.join(os.homedir(), ".codex", "ipc", "ipc.sock"),
    onStatusChange = () => {},
    maxCandidatesPerRefresh = MAX_CANDIDATES_PER_REFRESH
  } = {}) {
    this.socketPath = socketPath;
    this.onStatusChange = onStatusChange;
    this.maxCandidatesPerRefresh = maxCandidatesPerRefresh;
    this.socket = null;
    this.decoder = new LengthPrefixedFrameDecoder();
    this.clientId = INITIAL_CLIENT_ID;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.pending = new Map();
    this.owners = new Map();
    this.statuses = new Map();
    this.statusWaiters = new Map();
    this.probes = new Map();
    this.retryAfter = new Map();
    this.revalidating = new Set();
    this.reconnectTimer = null;
    this.stopped = false;
    this.lastCandidateIds = new Set();
    this.metrics = {
      startedAt: Date.now(),
      rxBytes: 0,
      txBytes: 0,
      messages: 0,
      ignoredMessages: 0,
      parseErrors: 0,
      oversizedFrames: 0,
      maxFrameBytes: 0,
      probesStarted: 0,
      followsStarted: 0,
      followsStopped: 0
    };
  }

  start() {
    if (this.clientId !== INITIAL_CLIENT_ID && this.socket?.writable) {
      return Promise.resolve();
    }
    if (this.readyPromise) return this.readyPromise;
    if (!fs.existsSync(this.socketPath)) {
      return Promise.reject(new Error("Codex IPC socket is unavailable"));
    }
    this.stopped = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    socket.on("connect", () => {
      this.request(
        "initialize",
        { clientType: "codex-companion-read-only" },
        { timeoutMs: 2_000 }
      ).catch((error) => this.failReady(error));
    });
    socket.on("data", (chunk) => this.ingest(chunk));
    socket.on("error", (error) => this.handleDisconnect(error));
    socket.on("close", () => this.handleDisconnect(new Error("Codex IPC closed")));
    return this.readyPromise;
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancelAllFollowing();
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.resetConnectionState(new Error("Codex IPC stopped"));
  }

  statusFor(threadId) {
    return this.statuses.get(threadId)?.status || "unknown";
  }

  refreshCandidates(threadIds) {
    const unique = [...new Set(threadIds.filter(Boolean))]
      .slice(0, this.maxCandidatesPerRefresh);
    this.lastCandidateIds = new Set(unique);
    const now = Date.now();
    this.expireUnavailableStatuses(now);
    this.pruneStatuses(now);
    if (unique.length === 0) return Promise.resolve([]);
    return this.start()
      .then(() => Promise.allSettled(unique.map((id) => {
        const observation = this.statuses.get(id);
        const retryAt = this.retryAfter.get(id) || 0;
        const force = Boolean(observation)
          && now - observation.observedAt >= STATUS_REVALIDATION_MS
          && now >= retryAt;
        if (observation && !force) return observation.status;
        return this.probe(id, { force });
      })))
      .catch(() => []);
  }

  probe(threadId, { force = false } = {}) {
    if (force) {
      // A client can stop publishing a final state when a turn is aborted or
      // the Codex window is closed. Drop the cached owner before the fresh
      // discovery so an old `active` value cannot live forever. Keep the last
      // visible status until the fresh snapshot arrives; this avoids a false
      // zero-count frame during the short IPC round trip.
      this.cancelFollowing(threadId);
      this.retryAfter.delete(threadId);
      this.revalidating.add(threadId);
    }
    if (this.probes.has(threadId)) return this.probes.get(threadId);
    if ((this.retryAfter.get(threadId) || 0) > Date.now()) {
      return Promise.resolve(this.statusFor(threadId));
    }
    this.metrics.probesStarted += 1;
    let ownerId = null;
    const probe = this.request(
      "thread-owner-discovery",
      { hostId: "local", conversationId: threadId },
      { version: IPC_VERSION["thread-owner-discovery"], timeoutMs: 1_200 }
    ).then(async (response) => {
      if (response.resultType !== "success" || !response.handledByClientId) {
        this.markUnavailable(threadId, { preserveActive: force });
        return "unknown";
      }
      ownerId = response.handledByClientId;
      this.owners.set(threadId, ownerId);
      const statusPromise = this.waitForStatus(
        threadId,
        1_200,
        { ignoreCurrent: force, preserveActive: force }
      );
      this.broadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId: "local", following: true },
        {
          version: IPC_VERSION["thread-stream-following-changed"],
          targetClientIds: [ownerId]
        }
      );
      this.metrics.followsStarted += 1;
      return await statusPromise;
    }).catch(() => {
      this.markUnavailable(threadId, { preserveActive: force });
      return "unknown";
    }).finally(() => {
      // Companion only needs a point-in-time runtime status. Keeping the
      // conversation stream open delivers full thread updates and makes CPU
      // cost grow with historical sessions. Always release the temporary
      // follow after the first status snapshot or timeout.
      this.cancelFollowing(threadId, ownerId);
      this.probes.delete(threadId);
      this.revalidating.delete(threadId);
    });
    this.probes.set(threadId, probe);
    return probe;
  }

  markUnavailable(threadId, { preserveActive = false } = {}) {
    this.cancelFollowing(threadId);
    const current = this.statuses.get(threadId);
    const activeUnavailableSince = current?.unavailableSince || Date.now();
    const keepActive = preserveActive
      && isActiveRuntimeStatus(current?.status)
      && Date.now() - activeUnavailableSince < ACTIVE_FAILURE_GRACE_MS;
    if (keepActive) {
      this.statuses.set(threadId, {
        ...current,
        unavailableSince: activeUnavailableSince
      });
    } else {
      this.setStatus(threadId, "notLoaded");
    }
    this.retryAfter.set(threadId, Date.now() + UNAVAILABLE_RETRY_MS);
  }

  expireUnavailableStatuses(now = Date.now()) {
    for (const [threadId, observation] of this.statuses) {
      if (
        isActiveRuntimeStatus(observation?.status)
        && observation?.unavailableSince
        && now - observation.unavailableSince >= ACTIVE_FAILURE_GRACE_MS
      ) {
        this.setStatus(threadId, "notLoaded");
      }
    }
  }

  pruneStatuses(now = Date.now()) {
    for (const [threadId, observation] of this.statuses) {
      if (
        !this.lastCandidateIds.has(threadId)
        && !isActiveRuntimeStatus(observation?.status)
        && now - Number(observation?.observedAt || 0) >= STATUS_RETENTION_MS
      ) {
        this.statuses.delete(threadId);
        this.retryAfter.delete(threadId);
      }
    }
  }

  cancelFollowing(threadId, ownerId = this.owners.get(threadId)) {
    const registeredOwner = this.owners.get(threadId);
    const targetOwner = registeredOwner === ownerId ? ownerId : registeredOwner;
    if (targetOwner && this.socket?.writable) {
      this.broadcast(
        "thread-stream-following-changed",
        { conversationId: threadId, hostId: "local", following: false },
        {
          version: IPC_VERSION["thread-stream-following-changed"],
          targetClientIds: [targetOwner]
        }
      );
      this.metrics.followsStopped += 1;
    }
    this.owners.delete(threadId);
  }

  cancelAllFollowing() {
    for (const [threadId, ownerId] of [...this.owners.entries()]) {
      this.cancelFollowing(threadId, ownerId);
    }
  }

  diagnostics() {
    const elapsedSeconds = Math.max(
      0.001,
      (Date.now() - this.metrics.startedAt) / 1_000
    );
    return {
      ...this.metrics,
      rxBytesPerSecond: this.metrics.rxBytes / elapsedSeconds,
      txBytesPerSecond: this.metrics.txBytes / elapsedSeconds,
      connected: Boolean(this.socket?.writable),
      candidates: this.lastCandidateIds.size,
      activeFollows: this.owners.size,
      cachedStatuses: this.statuses.size,
      pendingRequests: this.pending.size,
      pendingProbes: this.probes.size,
      bufferedBytes: this.decoder.length
    };
  }

  waitForStatus(
    threadId,
    timeoutMs,
    { ignoreCurrent = false, preserveActive = false } = {}
  ) {
    const current = this.statusFor(threadId);
    if (!ignoreCurrent && current !== "unknown") return Promise.resolve(current);
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const waiters = this.statusWaiters.get(threadId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.statusWaiters.delete(threadId);
        this.markUnavailable(threadId, { preserveActive });
        resolve("notLoaded");
      }, timeoutMs);
      const waiters = this.statusWaiters.get(threadId) || new Set();
      waiters.add(waiter);
      this.statusWaiters.set(threadId, waiters);
    });
  }

  request(method, params, { version, targetClientId, timeoutMs = 2_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.writable) {
        reject(new Error("Codex IPC is not connected"));
        return;
      }
      const requestId = crypto.randomUUID();
      const message = {
        type: "request",
        requestId,
        sourceClientId: this.clientId,
        method,
        params,
        timeoutMs
      };
      if (version !== undefined) message.version = version;
      if (targetClientId) message.targetClientId = targetClientId;
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(new Error(`${method} timed out`));
        }
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write(message);
    });
  }

  broadcast(method, params, { version, targetClientIds } = {}) {
    if (!this.socket?.writable) return;
    const message = {
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      params
    };
    if (version !== undefined) message.version = version;
    if (targetClientIds) message.targetClientIds = targetClientIds;
    this.write(message);
  }

  write(message) {
    const payload = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const frame = Buffer.concat([header, payload]);
    this.metrics.txBytes += frame.length;
    this.socket.write(frame);
  }

  ingest(chunk) {
    this.metrics.rxBytes += chunk.length;
    this.decoder.push(chunk);
    while (this.decoder.length >= 4) {
      let payload;
      try {
        payload = this.decoder.nextFrame();
      } catch {
        this.metrics.oversizedFrames += 1;
        this.decoder.clear();
        this.socket?.destroy();
        return;
      }
      if (!payload) return;
      this.metrics.maxFrameBytes = Math.max(
        this.metrics.maxFrameBytes,
        payload.length
      );
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.metrics.parseErrors += 1;
        continue;
      }
      this.metrics.messages += 1;
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (
        message.method === "initialize"
        && message.resultType === "success"
        && message.result?.clientId
      ) {
        this.clientId = message.result.clientId;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
      }
      pending.resolve(message);
      return;
    }
    if (
      message.type === "broadcast"
      && message.method === "thread-stream-state-changed"
    ) {
      this.handleStateChange(message.params);
      return;
    }
    // Never mirror another client's following request. That behavior made the
    // subscription set grow with every Codex window and delivered unrelated
    // conversation streams to this read-only status client.
    this.metrics.ignoredMessages += 1;
  }

  handleStateChange(params) {
    const threadId = params?.conversationId;
    const change = params?.change;
    if (!threadId || !change) return;
    if (change.type === "snapshot") {
      const status = change.conversationState?.threadRuntimeStatus?.type;
      this.setStatus(threadId, typeof status === "string" ? status : "notLoaded");
      return;
    }
    if (change.type !== "patches" || !Array.isArray(change.patches)) return;
    for (const patch of change.patches) {
      const components = Array.isArray(patch?.path)
        ? patch.path.map(String)
        : String(patch?.path || "").split("/").filter(Boolean);
      const index = components.indexOf("threadRuntimeStatus");
      if (index < 0) continue;
      if (components[index + 1] === "type" && typeof patch.value === "string") {
        this.setStatus(threadId, patch.value);
      } else if (typeof patch.value?.type === "string") {
        this.setStatus(threadId, patch.value.type);
      } else if (patch.op === "remove") {
        this.setStatus(threadId, "notLoaded");
      }
    }
  }

  setStatus(threadId, status) {
    const previous = this.statusFor(threadId);
    this.statuses.set(threadId, { status, observedAt: Date.now() });
    const waiters = this.statusWaiters.get(threadId);
    if (waiters) {
      this.statusWaiters.delete(threadId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(status);
      }
    }
    if (previous !== status) this.onStatusChange(threadId, status);
  }

  failReady(error) {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
  }

  handleDisconnect(error) {
    if (!this.socket) return;
    this.socket = null;
    this.resetConnectionState(error);
    if (!this.stopped && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.start().catch(() => {});
      }, 1_000);
    }
  }

  resetConnectionState(error) {
    this.decoder.clear();
    this.clientId = INITIAL_CLIENT_ID;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.statusWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve("notLoaded");
      }
    }
    this.statusWaiters.clear();
    const unavailableSince = Date.now();
    const activeStatuses = [...this.statuses.entries()]
      .filter(([, observation]) => isActiveRuntimeStatus(observation?.status))
      .map(([threadId, observation]) => [threadId, {
        ...observation,
        unavailableSince: observation.unavailableSince || unavailableSince
      }]);
    this.owners.clear();
    this.statuses.clear();
    this.probes.clear();
    this.retryAfter.clear();
    this.revalidating.clear();
    for (const [threadId, observation] of activeStatuses) {
      this.statuses.set(threadId, observation);
      this.retryAfter.set(threadId, unavailableSince + UNAVAILABLE_RETRY_MS);
    }
    this.failReady(error);
  }
}

module.exports = {
  CodexIpcStatusClient,
  IPC_VERSION,
  LengthPrefixedFrameDecoder,
  MAX_CANDIDATES_PER_REFRESH,
  MAX_FRAME_BYTES
};

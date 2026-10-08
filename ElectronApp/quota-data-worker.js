"use strict";

const {
  isMainThread,
  parentPort,
  workerData
} = require("worker_threads");
const {
  CodexAppServerClient
} = require("./codex-app-server-client");
const {
  mergeAppServerRateLimitsUpdate,
  normalizeAppServerPayload
} = require("./codex-quota-provider");

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const UNSUPPORTED_RETRY_MS = 30 * 60_000;

function serializedError(error) {
  return {
    code: error?.code || "APP_SERVER_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}

function retryDelay(error, failureCount) {
  if (
    error?.code === "APP_SERVER_METHOD_UNSUPPORTED"
    || error?.code === "CODEX_BINARY_UNAVAILABLE"
  ) {
    return UNSUPPORTED_RETRY_MS;
  }
  return Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * (2 ** Math.min(Math.max(0, failureCount - 1), 6))
  );
}

class AppServerQuotaRuntime {
  constructor({
    executablePath,
    appVersion,
    now = Date.now,
    clientFactory = (options) => new CodexAppServerClient(options),
    emit = () => {}
  } = {}) {
    this.executablePath = executablePath;
    this.appVersion = appVersion;
    this.now = now;
    this.emit = emit;
    this.clientFactory = clientFactory;
    this.client = null;
    this.lastPayload = null;
    this.failureCount = 0;
    this.retryAt = 0;
    this.refreshPromise = null;
  }

  ensureClient() {
    if (this.client) return this.client;
    this.client = this.clientFactory({
      executablePath: this.executablePath,
      appVersion: this.appVersion
    });
    this.client.on("notification", ({ method, params }) => {
      if (method !== "account/rateLimits/updated") return;
      const limitId = params?.rateLimits?.limitId
        ?? params?.rateLimits?.limit_id
        ?? params?.rate_limits?.limitId
        ?? params?.rate_limits?.limit_id;
      if (limitId && limitId !== "codex") return;
      this.lastPayload = mergeAppServerRateLimitsUpdate(
        this.lastPayload,
        params
      );
      const rateLimits = normalizeAppServerPayload(this.lastPayload);
      if (!rateLimits) {
        this.emit({
          type: "refresh-requested",
          reason: "app-server-sparse-update"
        });
        return;
      }
      this.emit({
        type: "quota-updated",
        result: {
          rateLimits,
          fetchedAt: this.now(),
          source: "codex-app-server-event"
        }
      });
    });
    this.client.on("connected", () => {
      this.emit({ type: "provider-state", state: "connected" });
    });
    this.client.on("disconnected", (details) => {
      this.client = null;
      this.retryAt = this.now() + RETRY_BASE_MS;
      this.emit({
        type: "provider-state",
        state: "disconnected",
        retryAt: this.retryAt,
        details
      });
    });
    return this.client;
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshOnce();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async refreshOnce() {
    const now = this.now();
    if (now < this.retryAt) {
      const error = new Error("Codex app-server retry is temporarily deferred");
      error.code = "APP_SERVER_BACKOFF";
      error.retryAt = this.retryAt;
      throw error;
    }
    try {
      const payload = await this.ensureClient().readRateLimits();
      const rateLimits = normalizeAppServerPayload(payload);
      if (!rateLimits) {
        const error = new Error(
          "Codex app-server did not return a Codex quota window"
        );
        error.code = "APP_SERVER_INVALID_RESPONSE";
        throw error;
      }
      this.lastPayload = payload;
      this.failureCount = 0;
      this.retryAt = 0;
      return {
        rateLimits,
        fetchedAt: this.now(),
        source: "codex-app-server"
      };
    } catch (error) {
      this.failureCount += 1;
      this.retryAt = this.now() + retryDelay(error, this.failureCount);
      this.client?.stop();
      this.client = null;
      error.retryAt = this.retryAt;
      throw error;
    }
  }

  diagnostics() {
    return {
      connected: Boolean(this.client?.isConnected?.()),
      failureCount: this.failureCount,
      retryAt: this.retryAt,
      hasSnapshot: Boolean(this.lastPayload)
    };
  }

  stop() {
    this.client?.stop();
    this.client = null;
    this.refreshPromise = null;
  }
}

if (!isMainThread) {
  const runtime = new AppServerQuotaRuntime({
    executablePath: workerData?.executablePath,
    appVersion: workerData?.appVersion,
    emit: (message) => parentPort.postMessage(message)
  });
  parentPort.on("message", async (message) => {
    if (message?.type === "close") {
      runtime.stop();
      process.exit(0);
      return;
    }
    if (message?.type === "diagnostics") {
      parentPort.postMessage({
        id: message.id,
        result: runtime.diagnostics()
      });
      return;
    }
    if (message?.type !== "refresh" || !message.id) return;
    try {
      parentPort.postMessage({
        id: message.id,
        result: await runtime.refresh()
      });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: {
          ...serializedError(error),
          retryAt: Number(error?.retryAt) || null
        }
      });
    }
  });
}

module.exports = {
  AppServerQuotaRuntime,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  UNSUPPORTED_RETRY_MS,
  retryDelay
};

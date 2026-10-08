"use strict";

const path = require("path");
const { Worker } = require("worker_threads");

const WORKER_REQUEST_TIMEOUT_MS = 12_000;

class QuotaDataClient {
  constructor({
    executablePath,
    appVersion,
    resourcesPath = null,
    onQuotaUpdate = () => {},
    onRefreshRequested = () => {},
    onProviderState = () => {}
  } = {}) {
    this.executablePath = executablePath;
    this.appVersion = appVersion;
    this.resourcesPath = resourcesPath;
    this.onQuotaUpdate = onQuotaUpdate;
    this.onRefreshRequested = onRefreshRequested;
    this.onProviderState = onProviderState;
    this.worker = null;
    this.nextID = 1;
    this.pending = new Map();
    this.startCount = 0;
    this.lastState = "stopped";
    this.lastUpdateAt = null;
  }

  workerPath() {
    const packaged = this.resourcesPath
      ? path.join(this.resourcesPath, "Worker", "quota-data-worker.js")
      : null;
    return packaged || path.join(__dirname, "quota-data-worker.js");
  }

  start() {
    if (this.worker) return;
    const worker = new Worker(this.workerPath(), {
      workerData: {
        executablePath: this.executablePath,
        appVersion: this.appVersion
      }
    });
    this.worker = worker;
    this.startCount += 1;
    this.lastState = "starting";
    worker.on("message", (message) => this.handleMessage(message));
    worker.on("error", (error) => this.handleExit(error));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.handleExit(new Error(`quota data worker exited with code ${code}`));
      }
    });
  }

  handleMessage(message) {
    if (message?.type === "quota-updated" && message.result) {
      this.lastUpdateAt = Number(message.result.fetchedAt) || Date.now();
      this.onQuotaUpdate(message.result);
      return;
    }
    if (message?.type === "refresh-requested") {
      this.onRefreshRequested(message.reason || "app-server-event");
      return;
    }
    if (message?.type === "provider-state") {
      this.lastState = message.state || "unknown";
      this.onProviderState(message);
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || "Quota worker failed");
      error.code = message.error.code || "QUOTA_WORKER_ERROR";
      error.retryAt = message.error.retryAt;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  request(type) {
    this.start();
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error("quota data worker timed out"));
      }, WORKER_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type, id });
    });
  }

  refresh() {
    return this.request("refresh");
  }

  diagnostics() {
    return {
      workerRunning: Boolean(this.worker),
      workerStartCount: this.startCount,
      state: this.lastState,
      lastUpdateAt: this.lastUpdateAt
    };
  }

  handleExit(error) {
    const worker = this.worker;
    this.worker = null;
    this.lastState = "worker-exited";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (worker) {
      try {
        worker.removeAllListeners();
      } catch {
      }
    }
    this.onProviderState({
      type: "provider-state",
      state: "worker-exited",
      details: { message: error?.message || String(error) }
    });
  }

  stop() {
    const worker = this.worker;
    this.worker = null;
    this.lastState = "stopped";
    if (worker) {
      try {
        worker.postMessage({ type: "close" });
      } catch {
      }
      const terminateTimer = setTimeout(() => {
        void worker.terminate();
      }, 500);
      terminateTimer.unref?.();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("quota data worker stopped"));
    }
    this.pending.clear();
  }
}

module.exports = {
  QuotaDataClient,
  WORKER_REQUEST_TIMEOUT_MS
};

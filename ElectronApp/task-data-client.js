"use strict";

const path = require("path");
const { Worker } = require("worker_threads");

class TaskDataClient {
  constructor({ codexHome, globalStatePath, resourcesPath = null }) {
    this.codexHome = codexHome;
    this.globalStatePath = globalStatePath;
    this.resourcesPath = resourcesPath;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  workerPath() {
    const packaged = this.resourcesPath
      ? path.join(this.resourcesPath, "Worker", "task-data-worker.js")
      : null;
    return packaged || path.join(__dirname, "task-data-worker.js");
  }

  start() {
    if (this.worker) return;
    const worker = new Worker(this.workerPath(), {
      workerData: {
        codexHome: this.codexHome,
        globalStatePath: this.globalStatePath
      }
    });
    this.worker = worker;
    worker.on("message", (message) => {
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    worker.on("error", (error) => this.handleExit(error));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.handleExit(new Error(`task data worker exited with code ${code}`));
      }
    });
  }

  refresh() {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error("task data worker timed out"));
        }
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: "refresh", id });
    });
  }

  handleExit(error) {
    const worker = this.worker;
    this.worker = null;
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
  }

  stop() {
    const worker = this.worker;
    this.worker = null;
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
      pending.reject(new Error("task data worker stopped"));
    }
    this.pending.clear();
  }
}

module.exports = {
  TaskDataClient
};

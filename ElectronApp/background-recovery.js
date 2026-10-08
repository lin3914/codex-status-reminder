"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

function recoveryHelperPath(resourcesPath) {
  return path.join(resourcesPath, "Recovery", "CodexCompanionRecovery");
}

function appBundlePath(resourcesPath) {
  return path.resolve(resourcesPath, "..", "..");
}

function gracefulExitMarkerPath(userDataPath) {
  return path.join(userDataPath, "background-recovery-graceful-exit");
}

function recoveryCrashStatePath(userDataPath) {
  return path.join(userDataPath, "background-recovery-crash-state.json");
}

class BackgroundRecovery {
  constructor({
    resourcesPath,
    userDataPath,
    parentPID = process.pid,
    appPath = appBundlePath(resourcesPath),
    spawn = childProcess.spawn,
    fsModule = fs
  }) {
    this.resourcesPath = resourcesPath;
    this.userDataPath = userDataPath;
    this.parentPID = parentPID;
    this.appPath = appPath;
    this.spawn = spawn;
    this.fs = fsModule;
    this.child = null;
    this.token = null;
  }

  get helperPath() {
    return recoveryHelperPath(this.resourcesPath);
  }

  get markerPath() {
    return gracefulExitMarkerPath(this.userDataPath);
  }

  get crashStatePath() {
    return recoveryCrashStatePath(this.userDataPath);
  }

  isAvailable() {
    return Boolean(
      this.resourcesPath
        && this.userDataPath
        && this.appPath?.endsWith(".app")
        && this.fs.existsSync(this.helperPath)
    );
  }

  start(enabled) {
    this.stop();
    if (!enabled || !this.isAvailable()) {
      return { enabled: false, available: this.isAvailable() };
    }
    this.fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
    this.fs.rmSync(this.markerPath, { force: true });
    this.token = `${this.parentPID}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const child = this.spawn(
      this.helperPath,
      [
        String(this.parentPID),
        this.appPath,
        this.markerPath,
        this.crashStatePath,
        this.token
      ],
      { stdio: "ignore" }
    );
    child.unref?.();
    this.child = child;
    return { enabled: true, available: true };
  }

  markGracefulExit() {
    if (!this.token) return false;
    try {
      this.fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
      this.fs.writeFileSync(this.markerPath, this.token, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  markStableStartup() {
    try {
      this.fs.rmSync(this.crashStatePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  stop({ graceful = false } = {}) {
    if (graceful) this.markGracefulExit();
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
      }
    }
    this.child = null;
    this.token = null;
  }
}

module.exports = {
  BackgroundRecovery,
  appBundlePath,
  gracefulExitMarkerPath,
  recoveryCrashStatePath,
  recoveryHelperPath
};

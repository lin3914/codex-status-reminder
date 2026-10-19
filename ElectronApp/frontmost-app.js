"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const { recoveryHelperPath } = require("./background-recovery");

// Query NSWorkspace through the bundled helper, not a locale/version-dependent
// command-line description. This read-only query needs no Automation or
// Accessibility permission and must never block the Electron main thread.
async function readFrontmostBundleIdentifier({
  resourcesPath,
  execFile = childProcess.execFile,
  fsModule = fs
} = {}) {
  if (!resourcesPath) return null;
  const helperPath = recoveryHelperPath(resourcesPath);
  if (!fsModule.existsSync(helperPath)) return null;
  return new Promise((resolve) => {
    try {
      execFile(helperPath, ["--frontmost-bundle-id"], {
        encoding: "utf8", timeout: 2_000, maxBuffer: 4_096
      }, (error, stdout) => {
        if (error) return resolve(null);
        const identifier = String(stdout || "").trim();
        resolve(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(identifier)
          ? identifier : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// One read-only, event-driven AppKit observer. No Accessibility/Automation
// permissions, repeated process scans, or per-second foreground polling.
function createFrontmostApplicationMonitor({
  resourcesPath, onChange = () => {}, spawn = childProcess.spawn,
  fsModule = fs, parentPID = process.pid,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout
} = {}) {
  let child = null, retryTimer = null, readyTimer = null;
  let stopped = true, identifier = null, failures = 0, published = false;
  const helperPath = resourcesPath ? recoveryHelperPath(resourcesPath) : null;
  const publish = (next) => {
    if (published && identifier === next) return;
    published = true;
    identifier = next;
    onChange(next);
  };
  const clearTimers = () => {
    clearTimeoutFn(retryTimer); clearTimeoutFn(readyTimer);
    retryTimer = readyTimer = null;
  };
  const lost = (current) => {
    if (child !== current) return;
    child = null;
    clearTimers();
    try { current.kill(); } catch {}
    publish(null);
    if (stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
    retryTimer = setTimeoutFn(launch, delay);
    retryTimer?.unref?.();
  };
  const launch = () => {
    retryTimer = null;
    if (stopped || child || !helperPath || !fsModule.existsSync(helperPath)) return;
    let current;
    try {
      current = spawn(helperPath, ["--observe-frontmost-app", String(parentPID)], {
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true
      });
    } catch {
      // Route synchronous launch errors through the same bounded backoff.
      current = { kill() {} }; child = current; lost(current); return;
    }
    child = current;
    const startedAt = Date.now();
    let buffered = "";
    current.stdout.setEncoding("utf8");
    current.stdout.on("data", chunk => {
      if (child !== current || stopped) return;
      buffered += chunk;
      if (buffered.length > 8_192) { lost(current); return; }
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const next = JSON.parse(line).bundleIdentifier;
          if (next !== null && (typeof next !== "string"
              || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(next))) {
            throw new Error("Invalid foreground identity");
          }
          clearTimeoutFn(readyTimer); readyTimer = null;
          // A helper that emits one frame and immediately crashes must still
          // back off. Only a stable connection resets the crash budget.
          if (Date.now() - startedAt >= 30_000) failures = 0;
          publish(next);
        } catch { lost(current); return; }
      }
    });
    current.on("error", () => lost(current));
    current.on("exit", () => lost(current));
    current.stdout.on("end", () => lost(current));
    current.stdout.on("error", () => lost(current));
    readyTimer = setTimeoutFn(() => lost(current), 3_000);
    readyTimer?.unref?.();
    current.unref?.();
  };
  return {
    start() { if (!stopped) return; stopped = false; launch(); },
    stop() {
      stopped = true; clearTimers();
      const current = child; child = null; identifier = null;
      try { current?.kill(); } catch {}
    },
    getBundleIdentifier() { return identifier; }
  };
}

module.exports = { readFrontmostBundleIdentifier, createFrontmostApplicationMonitor };

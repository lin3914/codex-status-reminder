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

module.exports = { readFrontmostBundleIdentifier };

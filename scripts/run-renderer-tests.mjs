#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Renderer smoke requires macOS");
const arch = process.arch === "x64" ? "x86_64" : process.arch;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.electron;
const appVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const candidates = [
  path.join(root, "node_modules/electron/dist/Electron.app"),
  path.join(root, ".build/electron-runtime-" + arch, "Electron.app")
];
const runtime = candidates.find(appPath => {
  if (!fs.existsSync(path.join(appPath, "Contents/Info.plist"))) return false;
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).trim() === version;
  } catch { return false; }
});
if (!runtime) throw new Error("Matching pristine runtime missing; run npm run build first");
const env = { ...process.env };
const reportDir = env.CODEX_COMPANION_SMOKE_REPORT || fs.mkdtempSync(path.join(root, ".build/renderer-check-"));
const runID = randomUUID();
env.CODEX_COMPANION_SMOKE_REPORT = reportDir;
env.CODEX_COMPANION_TEST_RUN_ID = runID;
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(path.join(runtime, "Contents/MacOS/Electron"), [
  path.join(root, "Tests/Electron/renderer-smoke.cjs")
], { env, stdio: "inherit", timeout: 60_000 });
if (result.error) throw result.error;
const report = JSON.parse(fs.readFileSync(path.join(reportDir, "renderer-smoke.json"), "utf8"));
if (report.runID !== runID || report.version !== appVersion || report.electron !== version
    || report.passed !== true || report.checks?.length !== 5) {
  throw new Error("Incomplete, stale, failed or wrong-runtime renderer report: " + reportDir);
}
console.log("PASS fresh renderer report: 5/5, version " + report.version);
process.exitCode = result.status ?? 1;

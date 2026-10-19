#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Notification delivery test requires macOS");
const expected = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.electron;
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const arch = process.arch === "x64" ? "x86_64" : process.arch;
const runtime = [
  path.join(root, "node_modules/electron/dist/Electron.app"),
  path.join(root, `.build/electron-runtime-${arch}/Electron.app`)
].find(candidate => {
  const info = path.join(candidate, "Contents/Info.plist");
  if (!fs.existsSync(info)) return false;
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", info],
      {encoding: "utf8"}).trim() === expected;
  } catch { return false; }
});
if (!runtime) throw new Error("Matching pristine runtime is missing; run npm run build first");
const reportDir = process.env.CODEX_COMPANION_SMOKE_REPORT
  || fs.mkdtempSync(path.join(root, ".build/notification-check-"));
fs.mkdirSync(reportDir, {recursive: true});
const runID = randomUUID();
const env = {...process.env, CODEX_COMPANION_SMOKE_REPORT: reportDir, CODEX_COMPANION_TEST_RUN_ID: runID};
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(path.join(runtime, "Contents/MacOS/Electron"),
  [path.join(root, "Tests/Electron/notification-delivery.cjs")], {env, stdio: "inherit", timeout: 75_000});
if (result.error) throw result.error;
const report = JSON.parse(fs.readFileSync(path.join(reportDir, "notification-delivery.json"), "utf8"));
if (report.runID !== runID || report.version !== expectedVersion || report.electron !== expected
    || report.passed !== true || report.checks?.length !== 17) {
  throw new Error("Incomplete, stale, failed or wrong-runtime notification report: " + reportDir);
}
console.log("PASS fresh notification report: 17/17, Electron " + report.electron);
process.exitCode = result.status ?? 1;

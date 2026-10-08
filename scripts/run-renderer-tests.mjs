#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("Renderer smoke requires macOS");
const arch = process.arch === "x64" ? "x86_64" : process.arch;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.electron;
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
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(path.join(runtime, "Contents/MacOS/Electron"), [
  path.join(root, "Tests/Electron/renderer-smoke.cjs")
], { env, stdio: "inherit", timeout: 60_000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

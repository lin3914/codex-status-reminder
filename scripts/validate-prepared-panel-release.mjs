import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "../node_modules/@electron/asar/lib/asar.js";
import settingsModule from "../ElectronApp/settings-store.js";

const run = promisify(execFile), output = process.argv[2], temporary = process.argv[3];
assert(output && temporary && path.isAbsolute(output) && path.isAbsolute(temporary));
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8")).version;
const build = (await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", path.join(project, "Resources/Info.plist")])).stdout.trim();
const app = "/Applications/CodeX状态提醒.app";
const report = { startedAt: new Date().toISOString(), checks: [] };
const checked = (message) => { report.checks.push(message); console.log("PASS " + message); };
const plist = async (bundle, key) => (await run("/usr/libexec/PlistBuddy", ["-c", "Print :" + key, path.join(bundle, "Contents/Info.plist")])).stdout.trim();
const support = path.join(os.homedir(), "Library/Application Support/codex-companion");
try {
  const original = JSON.parse(await fs.readFile(path.join(temporary, "settings-before.json"), "utf8"));
  const current = JSON.parse(await fs.readFile(path.join(support, "settings.json"), "utf8"));
  assert.deepEqual(settingsModule.editableSettings(current), settingsModule.editableSettings(original));
  assert.equal(current.x, original.x); assert.equal(current.y, original.y);
  checked("all user preferences, Codex connection and desktop position restored");

  let runtime;
  for (const name of await fs.readdir(support)) {
    if (!/^menu-bar-runtime-\d+\.json$/.test(name)) continue;
    const candidate = JSON.parse(await fs.readFile(path.join(support, name), "utf8"));
    try { process.kill(candidate.pid, 0); runtime = candidate; } catch {}
  }
  assert(runtime && runtime.bundleIdentifier === "com.lindaozhi.codexstatusreminder");
  const pattern = "^/Applications/CodeX状态提醒\\.app/Contents/MacOS/Codex Companion( |$)";
  const pids = (await run("/usr/bin/pgrep", ["-f", pattern])).stdout.trim().split("\n").map(Number);
  assert.deepEqual(pids, [runtime.pid]);
  const command = (await run("/bin/ps", ["-p", String(runtime.pid), "-o", "args="])).stdout;
  assert(!command.includes("--remote-debugging") && !command.includes("--show-settings"));
  let debugReachable = false;
  try { debugReachable = (await fetch("http://127.0.0.1:9338/json/version", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  assert.equal(debugReachable, false);
  const backgroundOnly = (await run("/usr/bin/osascript", ["-e", `tell application "System Events" to get background only of first application process whose unix id is ${runtime.pid}`])).stdout.trim();
  assert.equal(backgroundOnly, "true");
  checked("one normally launched accessory app, no running Dock entry, debug arguments or debug endpoint");
  assert(runtime.trayBoundsInMenuBar && !runtime.trayDestroyed);
  assert.equal(runtime.trayCreateCount, 1); assert.equal(runtime.trayRecoveryCount, 0);
  assert.equal(runtime.imageTemplate, true); assert.equal(runtime.showMenuBarQuota, current.showMenuBarQuota);
  assert.equal(runtime.taskPanel.visible, false);
  assert.equal(runtime.taskPanel.prewarmCount, 1); assert.equal(runtime.taskPanel.createCount, 1);
  assert.equal(runtime.taskPanel.retained, true);
  checked("visible standard tray and one startup-prepared card after normal restarts");

  const archive = path.join(output, `Codex-Companion-${version}-${build}-macos-arm64.zip`);
  const extraction = await fs.mkdtemp(path.join(temporary, "archive-readback-"));
  await run("/usr/bin/ditto", ["-x", "-k", archive, extraction]);
  const unpacked = path.join(extraction, "bundle");
  await fs.rename(path.join(extraction, "CodeX状态提醒.app"), unpacked);
  for (const bundle of [app, unpacked]) {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    assert.equal(await plist(bundle, "CFBundleShortVersionString"), version);
    assert.equal(await plist(bundle, "CFBundleVersion"), build);
    assert.equal(await plist(bundle, "CFBundleIdentifier"), "com.lindaozhi.codexstatusreminder");
    assert.equal(await plist(bundle, "CFBundleIconFile"), "icon.icns");
    assert.equal(await plist(bundle, "LSUIElement"), "true");
    const arch = (await run("/usr/bin/lipo", ["-archs", path.join(bundle, "Contents/MacOS/Codex Companion")])).stdout.trim();
    assert.equal(arch, "arm64");
  }
  checked("installed and independently extracted archive versions, arm64 architecture and development signature structure agree");
  const installedASAR = path.join(app, "Contents/Resources/app.asar");
  const packagedASAR = path.join(unpacked, "Contents/Resources/app.asar");
  const oldASAR = path.join(temporary, "prior-app-bundle/Contents/Resources/app.asar");
  assert((await fs.readFile(installedASAR)).equals(await fs.readFile(packagedASAR)));
  const changed = [], unchanged = [];
  for (const item of listPackage(installedASAR).map(value => value.replace(/^\//, ""))) {
    let bytes;
    try { bytes = extractFile(installedASAR, item); } catch { continue; }
    if (item === "renderer" || !bytes) continue;
    assert(bytes.equals(await fs.readFile(path.join(temporary, "stage-arm64", item))), "Source staging mismatch: " + item);
    (bytes.equals(extractFile(oldASAR, item)) ? unchanged : changed).push(item);
  }
  assert.deepEqual(changed.sort(), ["main.js", "package.json", "preload-panel.js", "renderer/panel.html", "renderer/pet-panel.css"].sort());
  report.sourceComparison = { changed, unchanged };
  checked("32 shipped source/page resources match source staging; only five approved package files changed");
  for (const name of ["icon.icns", "TrayIcon/CodexCompanionTemplate.png", "TrayIcon/CodexCompanionTemplate@2x.png", "TrayIcon/CodexQuotaStarTemplate.png", "TrayIcon/CodexQuotaStarTemplate@2x.png"]) {
    const next = await fs.readFile(path.join(app, "Contents/Resources", name));
    assert(next.equals(await fs.readFile(path.join(temporary, "prior-app-bundle/Contents/Resources", name))));
    assert(next.equals(await fs.readFile(path.join(unpacked, "Contents/Resources", name))));
  }
  checked("logo, full tray icon and quota-star icons are unchanged and packaged correctly");
  const hash = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  assert((await fs.readFile(path.join(output, "SHA256SUMS"), "utf8")).startsWith(hash + "  "));
  report.archive = { name: path.basename(archive), sha256: hash, mode: "development-not-notarized" };
  checked("install archive checksum matches the delivered SHA256SUMS");
  report.runtime = { pid: runtime.pid, trayCreateCount: runtime.trayCreateCount, trayRecoveryCount: runtime.trayRecoveryCount, trayVisible: runtime.trayBoundsInMenuBar, trayTitle: runtime.trayTitle, taskPanel: runtime.taskPanel, backgroundOnly, debuggingEnabled: false };
  report.limitations = ["single Apple Silicon Mac", "other macOS versions, Intel, physical sleep/wake, multiple displays and long-term operation not physically tested", "no video-level physical first-frame timing", "retained UI increases memory; no energy savings claim", "development package is not Developer ID signed or notarized"];
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error.stack || error); process.exitCode = 1; }
report.completedAt = new Date().toISOString();
await fs.mkdir(path.join(output, "evidence"), { recursive: true });
await fs.writeFile(path.join(output, "evidence/final-validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error,archive:report.archive},null,2));

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatTrayQuotaTitle } from "../ElectronApp/tray-icon.js";

const run = promisify(execFile);
const port = Number(process.env.COMPANION_DEBUG_PORT || 9338);
const output = process.env.CODEX_COMPANION_VALIDATION_OUTPUT;
assert(output, "CODEX_COMPANION_VALIDATION_OUTPUT must name a distinct evidence directory");
const support = path.join(os.homedir(), "Library/Application Support/codex-companion");
const report = { startedAt: new Date().toISOString(), checks: [], failures: [], notVerified: [] };
const expectedVersion = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let original;
let evaluate;
let send;

async function waitFor(read, accept, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await read(); } catch (error) { last = { error: String(error) }; }
    if (accept(last)) return last;
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}
async function runtime() {
  for (const name of await fs.readdir(support)) {
    if (!/^menu-bar-runtime-\d+\.json$/.test(name)) continue;
    try {
      const value = JSON.parse(await fs.readFile(path.join(support, name), "utf8"));
      process.kill(value.pid, 0);
      return value;
    } catch {}
  }
  return null;
}
async function nativeQuota(enabled) {
  return waitFor(runtime, (v) => (
    v?.showMenuBarQuota === enabled && v.trayBoundsInMenuBar
    && v.trayCreateCount === 1 && !v.trayDestroyed
    && v.layoutPending === false
    && v.iconMode === (enabled ? "quota-star" : "full")
    && v.imageLogicalSize?.width === (enabled ? 9 : 22)
    && v.trayTitle === formatTrayQuotaTitle({
      showMenuBarQuota: enabled, quotaAvailable: v.weeklyQuotaAvailable,
      remainingPercent: v.weeklyQuotaRemainingPercent, resetAt: v.weeklyQuotaResetAt
    })
  ), "Native quota did not match the current setting");
}
async function panelVisible(expected) {
  // A retained renderer is not necessarily an on-screen window.
  return waitFor(runtime, (state) => state?.taskPanel.visible === expected,
    "Panel visibility did not match");
}
async function clickTray() {
  const state = await runtime();
  await run("/usr/bin/osascript", ["-e", `tell application "System Events"
    set targetProcess to first application process whose unix id is ${state.pid}
    repeat with bar in menu bars of targetProcess
      repeat with statusItem in menu bar items of bar
        set itemSize to size of statusItem
        if item 1 of itemSize > 18 then
          perform action "AXPress" of statusItem
          return
        end if
      end repeat
    end repeat
  end tell`]);
  await delay(350);
}
function passed(message) {
  report.checks.push(message);
  console.log(`PASS ${message}`);
}

try {
  await fs.mkdir(output, { recursive: true });
  const list = await waitFor(targets,
    (items) => Array.isArray(items) && items.some((item) => item.url.includes("settings.html")),
    "Settings renderer not available");
  const target = list.find((item) => item.url.includes("settings.html"));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let nextID = 1;
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    clearTimeout(waiter.timer);
    if (value.error) waiter.reject(new Error(value.error.message));
    else waiter.resolve(value.result);
  });
  send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextID++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await waitFor(() => evaluate("Boolean(window.companionSettings)"), (v) => v === true, "Settings preload not ready");
  original = await evaluate("window.companionSettings.get()");
  assert.equal(original.version, expectedVersion);
  report.original = { showDesktopWidget: original.showDesktopWidget, showMenuBarQuota: original.showMenuBarQuota, locale: original.locale };
  const first = await nativeQuota(original.showMenuBarQuota);
  report.initial = { pid: first.pid, title: first.trayTitle, remainingPercent: first.weeklyQuotaRemainingPercent };
  passed("installed version and original preferences read back");

  await evaluate("window.companionSettings.update({showMenuBarQuota:true})");
  if ((await runtime()).taskPanel.visible) { await clickTray(); await panelVisible(false); }
  await clickTray(); await panelVisible(true);
  await evaluate("window.companionSettings.update({showMenuBarQuota:false})");
  await nativeQuota(false);
  if (!(await runtime()).taskPanel.visible) {
    report.failures.push({
      scenario: "quota text changed while a tray-anchored panel was open and desktop widget was disabled",
      expected: "same task panel remains open and reanchors to the changed status-item width",
      observed: "panel window was destroyed, although the native quota title updated correctly",
      suspectedCodePath: "updateSettings -> ensureDesktopWidget -> unconditional closePanel"
    });
    console.log("FAIL open tray panel was destroyed by a quota preference change with desktop widget disabled");
  } else {
    await evaluate("window.companionSettings.update({showMenuBarQuota:true})");
    await nativeQuota(true); await panelVisible(true);
    await clickTray(); await panelVisible(false);
    passed("open task panel remains open when quota text is disabled and enabled");
  }

  await evaluate("window.companionSettings.update({showMenuBarQuota:false})");
  await nativeQuota(false); await clickTray(); await panelVisible(true);
  await clickTray(); await panelVisible(false);
  passed("native left click opens and closes the full panel with quota text disabled");

  await evaluate("window.companionSettings.update({showDesktopWidget:true,showMenuBarQuota:true})");
  await waitFor(targets, (items) => Array.isArray(items) && items.some((item) => item.url.includes("dot.html")), "Desktop dot did not appear");
  await nativeQuota(true);
  await evaluate("window.companionSettings.update({showDesktopWidget:false})");
  await waitFor(targets, (items) => Array.isArray(items) && !items.some((item) => item.url.includes("dot.html")), "Desktop dot did not disappear");
  await nativeQuota(true);
  passed("desktop widget was genuinely created then removed without changing native quota title");

  const toggleReads = [];
  for (let index = 0; index < 20; index += 1) {
    const enabled = index % 2 === 1;
    await evaluate(`window.companionSettings.update({showMenuBarQuota:${enabled}})`);
    const state = await nativeQuota(enabled);
    const saved = JSON.parse(await fs.readFile(path.join(support, "settings.json"), "utf8"));
    assert.equal(saved.showMenuBarQuota, enabled);
    assert.equal(state.pid, first.pid);
    toggleReads.push({ index: index + 1, enabled, title: state.trayTitle, createCount: state.trayCreateCount });
  }
  report.toggleReads = toggleReads;
  passed("20 consecutive preference changes saved correctly without recreating the tray or app");

  await evaluate("window.companionSettings.update({showMenuBarQuota:false})");
  await nativeQuota(false);
  await send("Page.reload", { ignoreCache: true });
  await waitFor(() => evaluate("Boolean(window.companionSettings)"), (v) => v === true, "Reloaded preload did not load");
  await waitFor(() => evaluate("document.getElementById('showMenuBarQuota').checked"), (v) => v === false, "Reloaded checkbox did not restore false");
  assert.equal((await evaluate("window.companionSettings.get()")).showMenuBarQuota, false);
  await nativeQuota(false);
  passed("settings renderer reload preserves the saved off preference and native icon");

  await evaluate("window.companionSettings.update({showMenuBarQuota:true})");
  const beforeOpen = await nativeQuota(true);
  for (let index = 0; index < 5; index += 1) {
    await run("/usr/bin/osascript", ["-e", 'tell application "Finder" to open (POSIX file "/Applications/CodeX状态提醒.app" as alias)']);
    const state = await nativeQuota(true);
    assert.equal(state.pid, beforeOpen.pid);
    assert.equal(state.trayCreateCount, 1);
  }
  passed("five Finder reopen requests retain one main process and one tray host");

  const beforeRight = await nativeQuota(true);
  const x = Math.round(beforeRight.trayBounds.x + beforeRight.trayBounds.width / 2);
  const y = Math.round(beforeRight.trayBounds.y + beforeRight.trayBounds.height / 2);
  try {
    await run("/usr/bin/swift", ["-e", `import CoreGraphics
      let point = CGPoint(x: ${x}, y: ${y})
      let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right)
      let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)`]);
    const afterRight = await waitFor(runtime, (v) => v?.lastRightClickAt > (beforeRight.lastRightClickAt || 0), "Mouse event did not produce a native right-click event", 2_000);
    report.nativeRightClickAt = afterRight.lastRightClickAt;
    passed("native right click reached the real configuration menu handler");
  } catch (error) {
    report.notVerified.push(`Native right-click could not be injected: ${String(error.message)}`);
  } finally {
    await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53']);
  }
  report.passed = report.failures.length === 0;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (evaluate && original) {
    try {
      await evaluate(`window.companionSettings.update(${JSON.stringify(report.original)})`);
      await nativeQuota(original.showMenuBarQuota);
      report.preferencesRestored = true;
    } catch (error) {
      report.preferencesRestored = false;
      report.restoreError = String(error);
      process.exitCode = 1;
    }
  }
  socket?.close();
  report.completedAt = new Date().toISOString();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "extended-interactions.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checkCount: report.checks.length, failures: report.failures, restored: report.preferencesRestored, notVerified: report.notVerified, error: report.error }, null, 2));
}

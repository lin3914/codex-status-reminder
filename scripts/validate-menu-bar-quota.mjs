import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { formatTrayQuotaTitle } from "../ElectronApp/tray-icon.js";

const run = promisify(execFile);
const port = Number(process.env.COMPANION_DEBUG_PORT || 9338);
const output = process.env.CODEX_COMPANION_VALIDATION_OUTPUT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/menu-bar-quota");
const support = path.join(os.homedir(), "Library/Application Support/codex-companion");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { testedAt: new Date().toISOString(), checks: [] };
const expectedVersion = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;
let socket;
let original;
let evaluate;

async function waitFor(read, predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await read();
    } catch (error) {
      latest = { error: String(error) };
      await delay(100);
      continue;
    }
    if (predicate(latest)) return latest;
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

async function activeRuntime() {
  for (const name of await fs.readdir(support)) {
    if (!/^menu-bar-runtime-\d+\.json$/.test(name)) continue;
    try {
      const state = JSON.parse(await fs.readFile(path.join(support, name), "utf8"));
      process.kill(state.pid, 0);
      if (state.bundleIdentifier === "com.lindaozhi.codexstatusreminder") return state;
    } catch {}
  }
  return null;
}

async function nativeQuota(enabled) {
  return waitFor(activeRuntime, (value) => (
    value?.showMenuBarQuota === enabled
    && value.trayTitle === formatTrayQuotaTitle({
      showMenuBarQuota: enabled,
      quotaAvailable: value.weeklyQuotaAvailable,
      remainingPercent: value.weeklyQuotaRemainingPercent,
      resetAt: value.weeklyQuotaResetAt
    })
    && value.trayBoundsInMenuBar === true
    && value.trayCreateCount === 1
    && value.imageTemplate === true
    && value.iconMode === (enabled ? "quota-star" : "full")
    && value.imageLogicalSize?.width === (enabled ? 9 : 22)
    && value.imageLogicalSize?.height === 22
    && value.imageScaleFactors.includes(1)
    && value.imageScaleFactors.includes(2)
    && value.layoutPending === false
  ), "native weekly quota title did not match the current setting");
}

async function accessibilityStatus(pid) {
  const { stdout } = await run("/usr/bin/osascript", ["-e",
    `tell application "System Events"
      set targetProcess to first application process whose unix id is ${pid}
      repeat with bar in menu bars of targetProcess
        repeat with statusItem in menu bar items of bar
          set itemSize to size of statusItem
          if item 1 of itemSize > 18 and item 2 of itemSize > 18 then
            set itemPosition to position of statusItem
            return (title of statusItem as text) & "|" & (item 1 of itemPosition as text) & "|" & (item 2 of itemPosition as text) & "|" & (item 1 of itemSize as text) & "|" & (item 2 of itemSize as text)
          end if
        end repeat
      end repeat
      return ""
    end tell`
  ]);
  const [title, x, y, width, height] = stdout.trim().split("|");
  return { title, x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

async function nativeClick(bounds, right = false, pid) {
  if (!right) {
    await run("/usr/bin/osascript", ["-e",
      `tell application "System Events"
        set targetProcess to first application process whose unix id is ${pid}
        repeat with bar in menu bars of targetProcess
          repeat with statusItem in menu bar items of bar
            set itemSize to size of statusItem
            if item 1 of itemSize > 18 then
              perform action "AXPress" of statusItem
              return
            end if
          end repeat
        end repeat
      end tell`
    ]);
    return;
  }
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await run("/usr/bin/swift", ["-e",
    `import CoreGraphics
    let point = CGPoint(x: ${x}, y: ${y})
    let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right)
    let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)`
  ]);
}

async function captureMenu(state, name) {
  const b = state.trayBounds;
  const display = state.trayDisplay.bounds;
  const x = Math.max(display.x, Math.round(b.x - 2));
  const y = Math.max(display.y, Math.round(b.y));
  try {
    await run("/usr/sbin/screencapture", [
      "-x", "-R", `${x},${y},${Math.ceil(b.width + 4)},${Math.ceil(b.height)}`,
      path.join(output, name)
    ]);
  } catch (error) {
    report.screenshotWarnings ||= [];
    report.screenshotWarnings.push(String(error.stderr || error.message));
  }
}

try {
  await fs.mkdir(output, { recursive: true });
  const target = await waitFor(targets,
    (items) => items.some((item) => item.url.includes("settings.html")),
    "Settings renderer was not open");
  const settingsTarget = target.find((item) => item.url.includes("settings.html"));
  socket = new WebSocket(settingsTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextID = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    clearTimeout(request.timer);
    if (value.error) request.reject(new Error(value.error.message));
    else request.resolve(value.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextID++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const value = await send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true
    });
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result?.value;
  };
  original = await evaluate("window.companionSettings.get()");
  assert.equal(original.version, expectedVersion);
  assert.equal(typeof original.showMenuBarQuota, "boolean");
  assert.equal(await evaluate(
    'document.querySelectorAll("#showMenuBarQuota[role=switch]").length'
  ), 1);
  assert.equal(await evaluate(
    'document.getElementById("showMenuBarQuota").closest("section").querySelector("h2").id'
  ), "general-title");
  report.checks.push("setting is one accessible switch in General");

  await evaluate("window.companionSettings.update({showMenuBarQuota:true})");
  const enabled = await nativeQuota(true);
  assert.equal(enabled.weeklyQuotaAvailable, true, "real weekly quota must be available");
  assert.equal(enabled.trayTitle,
    `${Math.round(enabled.weeklyQuotaRemainingPercent)}%`);
  assert.equal(enabled.weeklyQuotaRemainingPercent, original.quotaHealth.quotaRemainingPercent);
  report.enabledAccessibility = await accessibilityStatus(enabled.pid);
  assert.equal(report.enabledAccessibility.title, enabled.trayTitle);
  assert(Math.abs((report.enabledAccessibility.x + report.enabledAccessibility.width / 2)
    - (enabled.trayBounds.x + enabled.trayBounds.width / 2)) <= 2);
  assert(report.enabledAccessibility.width > 38 && report.enabledAccessibility.y >= 0);
  await captureMenu(enabled, "menu-enabled.png");
  report.enabled = enabled;
  report.checks.push("native status title equals real weekly quota, not unread tasks");
  report.checks.push("quota mode uses a narrow upper-left star with both 1x and 2x resources");

  await evaluate('document.getElementById("showMenuBarQuota").click()');
  const disabled = await nativeQuota(false);
  assert.equal(disabled.trayTitle, "");
  const savedOff = JSON.parse(await fs.readFile(path.join(support, "settings.json"), "utf8"));
  assert.equal(savedOff.showMenuBarQuota, false);
  assert(disabled.trayBounds.width < enabled.trayBounds.width);
  report.disabledAccessibility = await accessibilityStatus(disabled.pid);
  assert(report.disabledAccessibility.width >= 18);
  assert(report.disabledAccessibility.width < report.enabledAccessibility.width);
  assert(Math.abs((report.disabledAccessibility.x + report.disabledAccessibility.width / 2)
    - (disabled.trayBounds.x + disabled.trayBounds.width / 2)) <= 2,
    "disabled-mode anchor must use the settled native status-item position");
  await captureMenu(disabled, "menu-disabled.png");
  report.disabled = disabled;
  report.checks.push("switch immediately hides text, preserves icon, and saves false");
  report.checks.push("disabling quota restores the original complete 22pt menu icon");

  await evaluate('document.getElementById("showMenuBarQuota").focus()');
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await nativeQuota(true);
  report.checks.push("keyboard Space enables the switch and restores the native percentage");

  for (const [locale, label] of [
    ["en", "Show weekly quota in menu bar"],
    ["zh-CN", "菜单栏显示剩余周额度"]
  ]) {
    await evaluate(`window.companionSettings.update({locale:${JSON.stringify(locale)}})`);
    await waitFor(() => evaluate(
      'document.querySelector("[data-copy=showMenuBarQuota]").textContent'
    ), (value) => value === label, "localized switch label did not update");
    await nativeQuota(true);
  }
  report.checks.push("Chinese and English labels update without changing quota or tray identity");

  await evaluate("window.companionSettings.update({showDesktopWidget:true})");
  await waitFor(targets, (items) => items.some((item) => item.url.includes("dot.html")), "desktop widget did not appear");
  await nativeQuota(true);
  await evaluate("window.companionSettings.update({showDesktopWidget:false})");
  await waitFor(targets, (items) => !items.some((item) => item.url.includes("dot.html")), "desktop widget did not disappear");
  await nativeQuota(true);
  await evaluate(`window.companionSettings.update({showDesktopWidget:${original.showDesktopWidget}})`);
  await nativeQuota(true);
  report.checks.push("weekly title works while the desktop widget is actually created and removed");

  const beforeClick = await activeRuntime();
  if ((await activeRuntime()).taskPanel.visible) {
    await nativeClick(beforeClick.trayBounds, false, beforeClick.pid);
    await waitFor(activeRuntime, (state) => state?.taskPanel.visible === false, "initial panel did not close");
    await delay(350);
  }
  await nativeClick(beforeClick.trayBounds, false, beforeClick.pid);
  await waitFor(activeRuntime, (state) => state?.taskPanel.visible === true, "left click did not open full panel");
  await delay(350);
  await nativeClick((await activeRuntime()).trayBounds, false, beforeClick.pid);
  await waitFor(activeRuntime, (state) => state?.taskPanel.visible === false, "second left click did not close panel");
  report.checks.push("native left clicks open and close the full task panel with text enabled");

  if (process.env.COMPANION_VALIDATE_NATIVE_RIGHT_CLICK === "1") {
    const beforeRight = await activeRuntime();
    await nativeClick(beforeRight.trayBounds, true);
    await waitFor(activeRuntime, (value) => value.lastRightClickAt > beforeRight.lastRightClickAt, "native right click did not reach settings menu");
    await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to key code 53']);
    report.checks.push("native right click still opens the configuration menu");
  } else {
    report.notVerified = [
      "Physical right-click injection is not supported by this test session; the actual tray handler and its settings menu are covered by unit tests."
    ];
  }

  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(output, "settings.png"), Buffer.from(screenshot.data, "base64"));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (original && evaluate) {
    try {
      await evaluate(`window.companionSettings.update(${JSON.stringify({
        locale: original.locale,
        showDesktopWidget: original.showDesktopWidget,
        showMenuBarQuota: original.showMenuBarQuota
      })})`);
    } catch (error) {
      report.restoreError = String(error);
      process.exitCode = 1;
    }
  }
  socket?.close();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "validation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, error: report.error, output }, null, 2));
}

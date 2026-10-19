"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function systemChecks({root, base, resources, context, checked, waitFor,
  report, originalForegroundIdentifier}) {
  const { createFrontmostApplicationMonitor } = require(path.join(base, "frontmost-app.js"));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notification-system-"));
  const children = [];
  let observer;
  const until = async (predicate, message) => {
    for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(40); }
    throw new Error(message);
  };
  async function fixture(role) {
    const identifier = `dev.codex-status-reminder.test.${role}.p${process.pid}`;
    const contents = path.join(temporary, role + ".app", "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), {recursive: true});
    fs.copyFileSync(path.join(temporary, "fixture"), path.join(contents, "MacOS/Fixture"));
    fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Notification Test ${role}</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
    const child = spawn(path.join(contents, "MacOS/Fixture"), [String(process.pid)], {stdio: ["pipe", "pipe", "pipe"]});
    children.push(child);
    const pending = new Map(); let counter = 0, buffer = "";
    let ready; const started = new Promise(resolve => { ready = resolve; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const value = JSON.parse(line);
        if (value.event === "ready") ready(value);
        else { const waiter = pending.get(value.id); pending.delete(value.id); waiter?.(value); }
      }
    });
    child.stderr.on("data", () => {});
    const startupTimeout = setTimeout(() => ready({error: "fixture startup timeout"}), 5_000);
    const first = await started; clearTimeout(startupTimeout);
    assert.equal(first.bundleIdentifier, identifier, "native fixture must have its own actual bundle identity");
    return { child, identifier,
      request(type, extra = {}) {
        return new Promise((resolve, reject) => {
          const id = ++counter;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture command timeout: " + type)); }, 3_000);
          pending.set(id, value => {clearTimeout(timer); resolve(value);});
          child.stdin.write(JSON.stringify({id, type, ...extra}) + "\n");
        });
      }
    };
  }
  let other;
  try {
    await promisify(execFile)("/usr/bin/xcrun", ["swiftc", "-O", "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`,
      path.join(root, "Tests/Electron/NotificationWindowFixture.swift"), "-o", path.join(temporary, "fixture")], {timeout: 25_000});
    const codex = await fixture("codex"); other = await fixture("background");
    // Match a test-owned Codex carrier via the same additional-identity hook
    // as an actually discovered installation. No real Codex is controlled.
    context.discoveredCodexBundleIdentifiers = () => [codex.identifier];
    observer = createFrontmostApplicationMonitor({resourcesPath: resources,
      onChange: value => context.handleCompletionForegroundChange(value)});
    context.completionForegroundMonitor = observer;
    observer.start();
    await other.request("activate");
    await until(() => observer.getBundleIdentifier() === other.identifier,
      "native NSWorkspace observer did not report the background test app");
    checked("real read-only NSWorkspace activation stream identifies a separately bundled test app");
    await delay(10);
    const now = Date.now();
    const tasks = Array.from({length: 8}, (_, i) => ({id: "system-group-" + i,
      state: "unread", title: "系统前台验证 " + i, progress: "合成任务，不读取 Codex", completedAt: now - i}));
    const receipts = new Set(tasks.map(t => t.id));
    await context.handleCompletionNotifications(tasks, receipts);
    await waitFor("document.querySelector('.completion-notification-more')?.textContent === '+7'");
    const at = performance.now();
    await codex.request("activate");
    await until(() => observer.getBundleIdentifier() === codex.identifier, "native activation did not reach production handler");
    assert.equal(context.completionBannerWindow, null);
    assert.equal(context.completionBannerEntries.size, 0);
    assert.equal(Object.keys(context.completionNotificationState.pending).length, 0);
    assert.equal(receipts.size, 8, "activation must not alter Codex-like unread receipts");
    report.nativeActivationDismissMs = Math.round(performance.now() - at);
    checked("actual app activation clears eight production reminders without any task refresh or read-receipt update");
    await other.request("activate");
    await until(() => observer.getBundleIdentifier() === other.identifier, "background transition was not observed");
    await context.handleCompletionNotifications(tasks, receipts);
    assert.equal(context.completionBannerWindow, null);
    checked("switching away from Codex does not resurrect any acknowledged reminder");
    await delay(10);
    const later = {id: "system-later", state: "unread", title: "后续完成仍正常提醒", progress: "合成内容", completedAt: Date.now()};
    await context.handleCompletionNotifications([later], new Set([later.id]));
    let win = await waitFor("document.querySelector('.completion-notification-title')?.textContent === '后续完成仍正常提醒'");
    assert(win.isVisible());
    checked("a later background completion still renders a real reminder after global dismissal");

    const order = async layer => {
      const {windows} = await other.request("order", {pids: [process.pid, other.child.pid]});
      const ours = windows.findIndex(w => w.pid === process.pid && w.layer === 3);
      const peer = windows.findIndex(w => w.pid === other.child.pid && w.layer === layer);
      assert(ours >= 0, "production reminder must have the actual native floating level (3)");
      assert(peer >= 0, "newer peer notification must be visible at its requested native level");
      assert(peer < ours, "the newer peer notification must be above our reminder in macOS ordering");
      return {reminderLayer: windows[ours].layer, peerLayer: windows[peer].layer, peerAbove: peer < ours};
    };
    await other.request("peer", {bounds: win.getBounds(), level: "pop-up-menu"}); await delay(120);
    report.systemOverlayOrder = await order(101);
    checked("macOS window metadata confirms a later system-priority test notification is above the real floating reminder");
    await other.request("peer", {bounds: win.getBounds(), level: "floating"}); await delay(120);
    await order(3);
    for (let n = 0; n < 20; n++) await context.handleCompletionNotifications([later], new Set([later.id]));
    const newest = {...later, id: "system-newest", completedAt: Date.now(), title: "更新不抢占其他提醒"};
    await context.handleCompletionNotifications([later, newest], new Set([later.id, newest.id]));
    await delay(120);
    report.peerOverlayOrder = await order(3);
    checked("twenty refreshes and a new completion do not re-raise our visible card above a later equal-level peer notification");
  } finally {
    observer?.stop(); context.completionForegroundMonitor = null;
    context.closeAllCompletionBanners();
    if (other && originalForegroundIdentifier) {
      try { await other.request("restore", {bundleIdentifier: originalForegroundIdentifier}); } catch {}
    }
    for (const child of children) { try { child.stdin.end(); child.kill(); } catch {} }
    fs.rmSync(temporary, {recursive: true, force: true});
  }
};

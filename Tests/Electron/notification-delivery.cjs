"use strict";
// Exercise the packaged production notification functions and renderer with
// synthetic tasks. Never read/write Codex data, change OS preferences, or
// actually open a Codex conversation. All state is in this temporary profile.
const { app, BrowserWindow, ipcMain, screen } = require("electron");
// Keep real UI/IPC assertions on CI even without an accelerated capture
// surface. This does not change hardware acceleration in the installed app.
app.disableHardwareAcceleration();
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const root = path.resolve(__dirname, "../..");
const resources = path.join(root, ".build/products/CodeX状态提醒.app/Contents/Resources");
const base = path.join(resources, "app.asar");
const completion = require(path.join(base, "completion-notifications.js"));
const { readFrontmostBundleIdentifier } = require(path.join(base, "frontmost-app.js"));
const security = require(path.join(base, "renderer-security.js"));
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notification-delivery-"));
app.setPath("userData", isolated);
const reportDir = process.env.CODEX_COMPANION_SMOKE_REPORT || path.join(root, ".build/smoke");
fs.mkdirSync(reportDir, { recursive: true });
const main = fs.readFileSync(path.join(base, "main.js"), "utf8");
const report = { checks: [], synthetic: true, codexDataAccess: false,
  renderingMode: "isolated-test-software-capture" };
const checked = message => { report.checks.push(message); console.log("PASS " + message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const opened = [];
let foregroundMode = "unknown";
const now = Date.now(), completedAt = now - 20_000;
const context = {
  ...completion, ...security, BrowserWindow, ipcMain, screen, path,
  __dirname: base, Date, console, quitting: false,
  process: { resourcesPath: resources },
  childProcess: require("child_process"),
  resolveCodexExecutable: () => null, appBundleForExecutable: () => null,
  APP_SESSION_STARTED_AT: now - 60_000,
  COMPLETION_NOTIFICATION_STATE_PATH: path.join(isolated, "completion-state.json"),
  completionNotificationState: completion.normalizeCompletionNotificationState({ initialized: true }),
  lastCompletionNotificationStateJSON: "", lastCompletionNotificationDecision: null,
  completionBannerWindow: null, completionBannerExpanded: false,
  completionBannerEntries: new Map(), completionSystemNotifications: new Map(),
  settings: { notifyOnUnreadCompletion: true },
  effectiveLocale: () => "zh-CN", copyFor: () => ({ appName: "CodeX状态提醒" }),
  writeJSON: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
  openCodex: () => { throw new Error("Test must not launch Codex"); },
  shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } },
  Notification: class { static isSupported() { throw new Error("In-app banner must not need system notification permission"); } },
  readFrontmostBundleIdentifier: options => foregroundMode === "unknown"
    ? Promise.resolve(null) : foregroundMode === "codex"
      ? Promise.resolve("com.openai.codex") : readFrontmostBundleIdentifier(options)
};
vm.createContext(context);
const start = main.indexOf("function discoveredCodexBundleIdentifiers(");
const end = main.indexOf("\nfunction taskRank(", start);
assert(start >= 0 && end > start);
vm.runInContext(main.slice(start, end), context);
const ipcStart = main.indexOf('ipcMain.on("companion:notification-message"');
const ipcEnd = main.indexOf("\napp.whenReady()", ipcStart);
vm.runInContext(main.slice(ipcStart, ipcEnd), context);
const task = {
  id: "synthetic-completed-task", title: "完成提醒链路验证",
  progress: "此卡片来自模拟任务，已经过实际前台识别、提醒判断和打包后的窗口渲染。",
  state: "unread", completedAt, locale: "zh-CN"
};
async function waitFor(expression) {
  for (let i = 0; i < 80; i++) {
    const win = context.completionBannerWindow;
    if (win && !win.isDestroyed() && !win.webContents.isLoading()
        && await win.webContents.executeJavaScript(expression)) return win;
    await delay(40);
  }
  throw new Error("Packaged notification did not render: " + expression);
}

app.whenReady().then(async () => {
  let control;
  try {
    app.dock?.hide();
    await context.handleCompletionNotifications([task], new Set([task.id]));
    assert.equal(context.completionBannerWindow, null);
    assert.equal(context.completionNotificationState.completions[task.id], undefined);
    assert.equal(context.completionNotificationState.deferred[task.id], completedAt);
    checked("unknown foreground after 20 seconds retains the completion instead of losing it");
    // Activate only this isolated test app to make the real foreground query
    // deterministic; do not automate any other app or request special access.
    control = new BrowserWindow({ width: 240, height: 80, show: true, skipTaskbar: true });
    await control.loadURL("data:text/html,<title>通知链路验证</title><p>正在验证完成提醒，稍后自动关闭</p>");
    control.focus(); app.focus({ steal: true });
    await delay(200);
    let actualIdentifier = null;
    // A newly activated test process can briefly have no foreground identity.
    // Retry only in the test; production retains deferred decisions normally.
    for (let attempt = 0; attempt < 12; attempt++) {
      actualIdentifier = await readFrontmostBundleIdentifier({ resourcesPath: resources });
      if (completion.isCodexFrontmost(actualIdentifier) === false) break;
      await delay(150);
    }
    if (!actualIdentifier) {
      const probe = await new Promise(resolve => require("child_process").execFile(
        path.join(resources, "Recovery/CodexCompanionRecovery"), ["--frontmost-bundle-id"],
        {encoding: "utf8", timeout: 2_000}, (error, stdout, stderr) => resolve({
          code: error?.code || null, signal: error?.signal || null,
          stdout: String(stdout || "").trim(), stderr: String(stderr || "").slice(0, 500)
        })));
      console.log("Foreground helper diagnostic", JSON.stringify(probe));
    }
    assert.equal(completion.isCodexFrontmost(actualIdentifier), false,
      "bundled public API must identify the isolated test app, not unknown/Codex");
    report.foregroundQuery = { available: true, codexFrontmost: false, bundleIdentifier: actualIdentifier };
    checked("packaged native helper successfully reads NSWorkspace foreground without TCC permissions");
    foregroundMode = "native";
    await context.handleCompletionNotifications([task], new Set([task.id]));
    let win = await waitFor("document.querySelector('.completion-notification-title')?.textContent === '完成提醒链路验证'");
    assert(win.isVisible());
    assert.equal(context.completionNotificationState.pending[task.id], completedAt);
    assert.equal(context.completionNotificationState.deferred[task.id], undefined);
    const image = await win.webContents.capturePage();
    assert(!image.isEmpty());
    fs.writeFileSync(path.join(reportDir, "notification-delivery.png"), image.toPNG());
    checked("production completion handler displays a real packaged persistent banner after recovery");

    await context.handleCompletionNotifications([task], new Set([task.id]));
    assert.equal(context.completionBannerEntries.size, 1);
    await context.handleCompletionNotifications([{ ...task, state: "completed" }], null);
    assert(win.isVisible());
    assert.equal(context.completionNotificationState.pending[task.id], completedAt);
    checked("duplicate refresh and unread-read failure neither duplicate nor clear the banner");
    await win.webContents.executeJavaScript("document.querySelector('.completion-notification-close').click()");
    await delay(100);
    assert.equal(context.completionBannerWindow, null);
    assert.equal(context.completionNotificationState.pending[task.id], undefined);
    assert.equal(opened.length, 0);
    await context.handleCompletionNotifications([task], new Set([task.id]));
    assert.equal(context.completionBannerWindow, null);
    checked("real close-button IPC dismisses only the reminder and prevents resending the same completion");

    const tasks = [1, 2, 3].map(i => ({ ...task, id: `synthetic-group-${i}`,
      title: `模拟完成任务 ${i}`, completedAt: Date.now() + i }));
    await context.handleCompletionNotifications(tasks, new Set(tasks.map(t => t.id)));
    win = await waitFor("document.querySelector('.completion-notification-more')?.textContent === '+2'");
    await win.webContents.executeJavaScript("document.querySelector('.completion-notification-more').click()");
    win = await waitFor("document.querySelectorAll('.completion-notification-row').length === 3");
    assert.equal(await win.webContents.executeJavaScript(
      "document.querySelector('.completion-notification-row-title').textContent"), "模拟完成任务 3");
    checked("three real completion events use the existing expandable group and newest-first ordering");
    await context.handleCompletionNotifications(tasks.map(t => ({...t, state: "completed"})), new Set());
    assert.equal(context.completionBannerWindow, null);
    checked("successful Codex read receipts close all viewed completion banners");
    foregroundMode = "codex";
    const foregroundTask = {...task, id: "synthetic-foreground", completedAt: Date.now()};
    await context.handleCompletionNotifications([foregroundTask], new Set([foregroundTask.id]));
    assert.equal(context.completionBannerWindow, null);
    assert.equal(context.completionNotificationState.completions[foregroundTask.id], foregroundTask.completedAt);
    checked("Codex-foreground completion is consumed without an intrusive banner");
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = String(error.stack || error);
    console.error(error); process.exitCode = 1;
  } finally {
    context.closeAllCompletionBanners();
    control?.destroy();
    fs.writeFileSync(path.join(reportDir, "notification-delivery.json"), JSON.stringify(report, null, 2));
    // Only this test-owned temporary profile, never application/Codex state.
    fs.rmSync(isolated, { recursive: true, force: true });
    app.exit(report.passed ? 0 : 1);
  }
});

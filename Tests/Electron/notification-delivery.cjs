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
  __dirname: base, Date, console, setTimeout, clearTimeout, quitting: false,
  process: { resourcesPath: resources },
  childProcess: require("child_process"),
  resolveCodexExecutable: () => null, appBundleForExecutable: () => null,
  APP_SESSION_STARTED_AT: now - 60_000,
  COMPLETION_NOTIFICATION_STATE_PATH: path.join(isolated, "completion-state.json"),
  completionNotificationState: completion.normalizeCompletionNotificationState({ initialized: true }),
  lastCompletionNotificationStateJSON: "", lastCompletionNotificationDecision: null,
  lastCompletionNotificationPersistenceError: null, lastCompletionBannerFailure: null,
  lastCompletionBannerContentJSON: null, completionBannerRecoveryTimer: null,
  completionBannerFailureTimes: [],
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
  for (let i = 0; i < 160; i++) {
    const win = context.completionBannerWindow;
    if (win && !win.isDestroyed() && !win.webContents.isLoading() && !win.webContents.isCrashed()) {
      try {
        if (await win.webContents.executeJavaScript(expression)) return win;
      } catch (error) {
        if (context.completionBannerWindow === win && !win.isDestroyed()
            && !win.webContents.isDestroyed() && !win.webContents.isCrashed()) throw error;
      }
    }
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

    const crashed = win;
    const rendererGone = new Promise(resolve => crashed.webContents.once("render-process-gone", resolve));
    crashed.webContents.forcefullyCrashRenderer();
    // Do not issue renderer JavaScript while its process is being killed: an
    // evaluation started in that interval may never settle in Electron.
    await rendererGone;
    // The main process must stay alive and recover only its notification
    // renderer. This process and every window in it are test-owned.
    win = await waitFor("document.querySelector('.completion-notification-title')?.textContent === '完成提醒链路验证'");
    assert.notEqual(win, crashed);
    assert(crashed.isDestroyed());
    assert.equal(context.completionNotificationState.pending[task.id], completedAt);
    assert.equal(context.lastCompletionBannerFailure?.reason, "renderer-gone");
    checked("real Electron renderer crash recreates the banner without an app restart or losing pending content");

    context.closeAllCompletionBanners();
    context.completionNotificationState = completion.normalizeCompletionNotificationState(
      JSON.parse(fs.readFileSync(context.COMPLETION_NOTIFICATION_STATE_PATH, 'utf8')));
    await context.handleCompletionNotifications([], null);
    win = await waitFor("document.querySelector('.completion-notification-title')?.textContent === '完成提醒链路验证'");
    assert(win.isVisible());
    checked("serialized pending reminder restores real content when both task index and read receipts are unavailable");

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

    const tasks = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({ ...task, id: `synthetic-group-${i}`,
      title: `模拟完成任务 ${i}`, completedAt: Date.now() + i }));
    await context.handleCompletionNotifications(tasks, new Set(tasks.map(t => t.id)));
    win = await waitFor("document.querySelector('.completion-notification-more')?.textContent === '+7'");
    await win.webContents.executeJavaScript("document.querySelector('.completion-notification-more').click()");
    win = await waitFor("document.querySelectorAll('.completion-notification-row').length === 8");
    assert.equal(await win.webContents.executeJavaScript(
      "document.querySelector('.completion-notification-row-title').textContent"), "模拟完成任务 8");
    await win.webContents.executeJavaScript("document.querySelector('.completion-notification-list').scrollTop = 160");
    const scrollBefore = await win.webContents.executeJavaScript("document.querySelector('.completion-notification-list').scrollTop");
    assert(scrollBefore > 0);
    await context.handleCompletionNotifications(tasks, new Set(tasks.map(t => t.id)));
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('.completion-notification-list').scrollTop"), scrollBefore);
    fs.writeFileSync(path.join(reportDir, "notification-eight-expanded.png"), (await win.capturePage()).toPNG());
    checked("eight real completions group newest-first, remain scrollable and preserve scroll position on unchanged refresh");
    await win.webContents.executeJavaScript("document.querySelector('.completion-notification-row').click()");
    await delay(100);
    assert.equal(opened.at(-1), "codex://threads/synthetic-group-8");
    assert.equal(context.completionNotificationState.pending["synthetic-group-8"], undefined);
    assert.equal(context.completionBannerEntries.size, 7);
    await context.handleCompletionNotifications(tasks, new Set(tasks.map(t => t.id)));
    assert.equal(context.completionBannerEntries.size, 7);
    checked("real task-body IPC opens exactly that conversation and removes only its banner, without resending it");
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

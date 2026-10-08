"use strict";
// Run with the pristine matching Electron executable after npm run build.
// Does not import the production main entry, read Codex, create a Tray,
// register login items, or launch the installed app.
const { app, BrowserWindow, ipcMain } = require("electron");
// CI Macs may not expose a working virtual GPU/Viz capture surface. Use
// software capture only in this isolated test process, not in the application.
app.disableHardwareAcceleration();
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "../..");
const candidateVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const base = path.join(root, ".build/products/CodeX状态提醒.app/Contents/Resources/app.asar");
const { rendererURL, protectRendererWindow, trustedRendererEvent } = require(path.join(base, "renderer-security.js"));
const { normalizeSettings } = require(path.join(base, "settings-store.js"));
const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-renderer-smoke-"));
app.setPath("userData", isolatedData);
const windows = {};
const messages = [], unexpectedConsole = [];
const reportDir = process.env.CODEX_COMPANION_SMOKE_REPORT || path.join(root, ".build/smoke");
fs.mkdirSync(reportDir, { recursive: true });
let settings = {
  ...normalizeSettings(), effectiveLocale: "zh-CN", version: candidateVersion,
  codexConnection: {
    valid: true, title: "已自动连接 Codex",
    pathLabel: "~/.codex", manualSelectionAvailable: false
  }, menuBarStatus: { state: "visible" }
};
const panelState = {
  quotaValue: "81%", timeValue: "85%", resetValue: "5天 23小时",
  unreadCount: 1, runningCount: 1, health: "healthy", healthLabel: "正常使用",
  healthDescription: "演示数据", locale: "zh-CN", direction: "down",
  tasks: [
    { id: "demo-unread", title: "整理项目计划", progress: "已完成，等待查看。", stateLabel: "待查看", stateClass: "unread" },
    { id: "demo-running", title: "检查文档格式", progress: "正在核对文档。", stateLabel: "进行中", stateClass: "running" },
    { id: "demo-processed", title: "核对代码样本", progress: "已查看。", stateLabel: "已处理", stateClass: "completed" }
  ], renderRevision: 1
};
let notificationExpanded = false;
const notificationState = () => ({
  locale: "zh-CN", expanded: notificationExpanded, expandedContentHeight: 260,
  collapsedLayers: 2,
  items: [1, 2, 3].map(i => ({
    threadID: "demo-notification-" + i,
    title: i === 1 ? "整理项目计划" : "示例任务 " + i,
    body: "演示进展：工作已完成，点击查看对应会话。",
    closeLabel: "关闭通知", appName: "CodeX状态提醒"
  }))
});
const dotState = {
  quotaAvailable: true, quotaRemainingPercent: 81, timeRemainingPercent: 85,
  unreadCount: 0, runningCount: 1, health: "healthy", healthProgress: 0,
  accessibilityLabel: "演示：81% 周额度剩余"
};
function requireTrusted(event, name) {
  assert(trustedRendererEvent(event, windows[name], rendererURL(base, name + ".html")), name + " real IPC sender must match packaged main frame");
}
for (const channel of ["get", "update"]) {
  ipcMain.handle("companion:settings-" + channel, (event, patch) => {
    requireTrusted(event, "settings");
    messages.push({ window: "settings", type: channel });
    if (channel === "get") return settings;
    const next = normalizeSettings({ ...settings, ...patch });
    settings = {
      ...settings, ...next, codexConnection: { ...next.codexConnection, ...settings.codexConnection },
      effectiveLocale: next.locale === "en" ? "en" : "zh-CN"
    };
    return { settings };
  });
}
ipcMain.on("companion:panel-message", (event, message) => {
  requireTrusted(event, "panel"); messages.push({ window: "panel", type: message.type });
  if (message.type === "ready") windows.panel.webContents.send("companion:snapshot", panelState);
});
ipcMain.on("companion:dot-message", (event, message) => {
  requireTrusted(event, "dot"); messages.push({ window: "dot", type: message.type });
  if (message.type === "ready") windows.dot.webContents.send("companion:snapshot", dotState);
});
ipcMain.on("companion:notification-message", (event, message) => {
  requireTrusted(event, "notification"); messages.push({ window: "notification", type: message.type });
  if (message.type === "toggle-expanded") notificationExpanded = !notificationExpanded;
  if (message.type === "ready" || message.type === "toggle-expanded") {
    windows.notification.webContents.send("companion:notification-content", notificationState());
  }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(name, expression) {
  for (let i = 0; i < 50; i++) {
    if (await windows[name].webContents.executeJavaScript(expression)) return;
    await delay(40);
  }
  throw new Error("Renderer did not become ready: " + name);
}
app.whenReady().then(async () => {
  app.dock?.hide();
  const checks = [];
  try {
    for (const [name, width, height] of [
      ["dot", 64, 64], ["panel", 360, 410], ["settings", 560, 900], ["notification", 440, 144]
    ]) {
      const win = new BrowserWindow({
        width, height, show: false, frame: false, transparent: true,
        backgroundColor: "#00000000",
        webPreferences: { preload: path.join(base, "preload-" + name + ".js"), sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      windows[name] = win;
      protectRendererWindow(win, rendererURL(base, name + ".html"));
      win.webContents.on("console-message", (_event, ...details) => {
        const message = typeof details[0] === "object" ? details[0].message : details[1];
        if (message && /error|violat|refused/i.test(message) && !String(message).includes("badSmokeProbe")) {
          unexpectedConsole.push({ name, message });
        }
      });
      await win.loadFile(path.join(base, "renderer", name + ".html"));
    }
    await waitFor("dot", "document.body.textContent.includes('81')");
    await waitFor("panel", "document.querySelectorAll('.status-task-row').length === 3");
    await waitFor("settings", "document.getElementById('app-version').textContent === " + JSON.stringify(candidateVersion));
    await waitFor("notification", "document.querySelectorAll('.completion-notification').length === 1");
    fs.writeFileSync(path.join(reportDir, "notification-collapsed.png"),
      (await windows.notification.capturePage()).toPNG());
    checks.push("all four packaged pages render through production preloads and real main-frame IPC");
    await windows.panel.webContents.executeJavaScript("document.querySelector('.status-task-row').click()");
    await windows.settings.webContents.executeJavaScript("document.getElementById('showDesktopWidget').click()");
    await waitFor("settings", "document.getElementById('showDesktopWidget').checked === false");
    await windows.notification.webContents.executeJavaScript("document.querySelector('.completion-notification-more').click()");
    await waitFor("notification", "document.querySelectorAll('.completion-notification-row').length === 3");
    windows.notification.setContentSize(440, 276);
    assert.equal(await windows.notification.webContents.executeJavaScript(
      "(()=>{const list=document.querySelector('.completion-notification-list');return list.scrollHeight<=list.clientHeight;})()"
    ), true, "three notifications must fit without clipping the last row");
    await windows.notification.webContents.executeJavaScript("document.querySelector('.completion-notification-close').click()");
    await delay(100);
    assert(messages.some(x => x.window === "panel" && x.type === "openTask"));
    assert(messages.some(x => x.window === "settings" && x.type === "update"));
    assert(messages.some(x => x.window === "notification" && x.type === "close"));
    checks.push("task click, settings save, notification expand and close IPC");
    await windows.settings.webContents.executeJavaScript("document.getElementById('showDesktopWidget').click()");
    await waitFor("settings", "document.getElementById('showDesktopWidget').checked === true");
    // Zero is a valid threshold, not an absent value. Verify display and math
    // stay on the same 0h / 6h linked boundaries.
    await windows.settings.webContents.executeJavaScript("window.companionSettings.update({quotaHealthyLeadDays:0,quotaHealthMode:'linked'})");
    windows.settings.webContents.send("companion:settings-changed", settings);
    await waitFor("settings", "document.getElementById('normal-range').textContent.includes('0')");
    assert.equal(settings.quotaHealthyLeadDays, 0);
    assert.equal(settings.quotaWarningLeadDays, 0.25);
    await windows.settings.webContents.executeJavaScript("window.companionSettings.update({quotaHealthyLeadDays:0.5,quotaHealthMode:'linked'})");
    windows.settings.webContents.send("companion:settings-changed", settings);
    await waitFor("settings", "document.getElementById('normal-range').textContent.includes('12')");
    checks.push("zero-hour display matches calculation, default 12h/24h restored");
    assert.deepEqual(unexpectedConsole, [], "legitimate renderer content must have no CSP or script errors");
    for (const [name, win] of Object.entries(windows)) {
      assert.equal(await win.webContents.executeJavaScript("typeof window.require"), "undefined");
      const img = await win.capturePage();
      fs.writeFileSync(path.join(reportDir, name + ".png"), img.toPNG());
      if (name === "settings") {
        await win.webContents.executeJavaScript("document.getElementById('quota-custom-toggle').click();document.getElementById('custom-warning-enabled').click()");
        await waitFor("settings", "document.getElementById('warning-setting-row').hidden === false");
        await win.webContents.executeJavaScript("document.querySelector('.settings-shell').scrollTop = 99999;window.scrollTo(0,99999);document.documentElement.scrollTop=99999");
        await delay(80);
        fs.writeFileSync(path.join(reportDir, "quota-settings.png"), (await win.capturePage()).toPNG());
      }
      // An injected DOM script must be blocked, while existing hashed scripts worked.
      await win.webContents.executeJavaScript("var s=document.createElement('script');s.textContent='window.badSmokeProbe=1';document.body.append(s)");
      assert.equal(await win.webContents.executeJavaScript("typeof window.badSmokeProbe"), "undefined");
    }
    checks.push("sandbox has no window.require, hashed CSP permits legitimate pages and blocks injected scripts");
    // Console will include the deliberately blocked probe; all earlier legitimate content must have been clean.
    const legitimateErrors = unexpectedConsole.filter(x => !/Content Security Policy|script-src|Refused to execute inline script/i.test(x.message));
    assert.deepEqual(legitimateErrors, []);
    fs.writeFileSync(path.join(reportDir, "renderer-smoke.json"), JSON.stringify({
      passed: true, checks, messages, electron: process.versions.electron,
      renderingMode: "isolated-test-software-capture",
      data: "synthetic only; no Codex data or installed app touched",
      screenshots: ["dot.png", "panel.png", "settings.png", "quota-settings.png", "notification-collapsed.png", "notification.png"]
    }, null, 2) + "\n");
    console.log("PASS Electron renderer smoke: " + checks.length + " groups; synthetic data only");
    for (const win of Object.values(windows)) if (!win.isDestroyed()) win.destroy();
    app.quit();
  } catch (error) {
    console.error(error.stack);
    for (const win of Object.values(windows)) if (!win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});

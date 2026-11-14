"use strict";

// Real packaged worker + production main functions + sandboxed panel. All
// data lives in a synthetic temporary home; no Tray, login item or real Codex.
const { app, BrowserWindow, screen, ipcMain } = require("electron");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const vm = require("node:vm"), assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const root = path.resolve(__dirname, "../..");
const base = path.join(root, ".build/products/CodeX状态提醒.app/Contents/Resources/app.asar");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cache-smoke-"));
const reportDir = fs.mkdtempSync(path.join(root, ".build/speed-cache-smoke-"));
app.setPath("userData", path.join(data, "electron"));
app.disableHardwareAcceleration();
const { TaskDataClient } = require(path.join(base, "task-data-client.js"));
const { speedPanel, nextSpeedUpdateDelay } = require(path.join(base, "token-speed.js"));
const { rendererURL, protectRendererWindow, trustedRendererEvent } = require(path.join(base, "renderer-security.js"));
const classification = require(path.join(base, "task-classification.js"));
const source = fs.readFileSync(path.join(base, "main.js"), "utf8");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return; await delay(20); }
  throw new Error("Timed out waiting for cache smoke condition");
}
let c, client;
app.whenReady().then(async () => {
  app.dock?.hide();
  const report = { version: JSON.parse(fs.readFileSync(path.join(base, "package.json"))).version,
    electron: process.versions.electron, synthetic: true };
  try {
    const now = Date.now(), startedAt = now - 20_000;
    const transcript = path.join(data, "fixture.jsonl");
    const globalStatePath = path.join(data, ".codex-global-state.json");
    fs.writeFileSync(globalStatePath, JSON.stringify({ "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": { local: [] }
    } }));
    const record = (at, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload }) + "\n";
    const usage = (total, last) => ({ type: "token_count", info: {
      total_token_usage: { input_tokens: 0, output_tokens: total }, last_token_usage: { input_tokens: 0, output_tokens: last }
    } });
    fs.writeFileSync(transcript, record(startedAt, { type: "task_started" })
      + record(now - 15_000, usage(300, 300)));
    const db = new DatabaseSync(path.join(data, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, name TEXT, preview TEXT, thread_source TEXT, source TEXT, cwd TEXT, agent_path TEXT)");
    db.prepare("INSERT INTO threads VALUES ('fixture', ?, ?, ?, 0, '后台速率缓存验证', '', 'cli', '', '', '')").run(transcript, now, now);
    db.close();
    client = new TaskDataClient({ codexHome: data, globalStatePath, resourcesPath: path.dirname(base) });
    let fullReads = 0;
    const refresh = client.refresh.bind(client);
    client.refresh = () => { fullReads++; return refresh(); };
    c = {
      ...classification, app, BrowserWindow, screen, ipcMain, fs, path, __dirname: base,
      rendererURL, protectRendererWindow, trustedRendererEvent, speedPanel, nextSpeedUpdateDelay,
      setTimeout, clearTimeout, Date, Set, Map,
      settings: { tokenSpeedWindowSeconds: 30 }, quitting: false,
      panelWindow: null, panelAnchor: null, panelRendererReady: false,
      panelClockTimer: null, speedDisplayTimer: null, speedSourceCheckTimer: null,
      speedSourceCheckInFlight: false, systemSleeping: false, screenLocked: false,
      speedSourceCheckCount: 0, lastSpeedSourceCheck: null,
      panelHiddenSince: null, panelSnapshotJSON: null, panelPresentationID: 0,
      panelPresentationSentKey: null, panelLastFrameLatencyMs: null,
      panelLastRendererMemoryKB: null, panelMemoryReleaseCount: 0, panelPrewarmCount: 0,
      panelRenderRevision: 0, panelRenderedRevision: 0, panelOpenStartedAt: null,
      panelLastOpenLatencyMs: null, panelLastOpenSource: null, panelCreateCount: 0, panelReuseCount: 0,
      panelReportedHeight: 1, panelDirection: "down", panelArrowX: 180,
      hoverOpenTimer: null, hoverCloseTimer: null, dotWindow: null,
      PANEL_WIDTH: 400, PANEL_MAX_HEIGHT: 545, PANEL_GAP: 2, DOT_SIZE: 44,
      HOVER_OPEN_MS: 80, HOVER_CLOSE_MS: 280,
      PANEL_RENDERER_MEMORY_BUDGET_KB: 192 * 1024, PANEL_MEMORY_RELEASE_IDLE_MS: 60_000,
      TASK_CHANGE_DEBOUNCE_MS: 300,
      TRANSCRIPT_RUNNING_MAX_AGE_MS: 86_400_000, ACTIVE_DISCOVERY_WINDOW_MS: 300_000,
      taskRefreshTimer: null, refreshingTasks: false, taskRefreshQueued: false,
      usageTimer: null, usageDueAt: 0, usageInFlight: false, usageNeedsRecheck: false,
      lastTaskSnapshotJSON: null, taskDataClient: client, runtimeStatusClient: null,
      snapshot: { tasks: [], quota: { available: false, health: "neutral" } },
      ensureTaskDataClient: () => client, syncTranscriptWatchers() {},
      cleanDisplayText: text => text, handleCompletionNotifications: async () => {},
      refreshTrayMenu() {}, sendSettingsSnapshot() {}, persistResourceDiagnostics() {},
      applyWindowPreferences() {}, writeMenuBarRuntime() {}, openTask() {},
      effectiveLocale: () => "zh-CN", copyFor: () => ({
        health: { neutral: ["待同步", "演示"] }, quotaRemaining: "额度剩余", timeRemaining: "时间剩余",
        resetCountdown: "重置倒计时", taskProgress: "任务进展", unread: "待查看", running: "进行中", completed: "已处理", syncing: "待同步"
      })
    };
    vm.createContext(c);
    vm.runInContext(source.match(/^const SPEED_(?:VISIBLE_)?SOURCE_CHECK_MS = [\d_]+;$/gm).join("\n"), c);
    for (const [from, to] of [
      ["function clearHoverOpenTimer(", "function createSettingsWindow("],
      ["function taskRank(", "function taskDataWorkerResourcesPath("],
      ["async function refreshTasks(", "function dateFromEpoch("],
      ["function quotaForDisplay(", "function sendDotSnapshot("],
      ["function sendPanelSnapshot(", "function openCodex("],
      ['ipcMain.on("companion:panel-message"', 'ipcMain.on("companion:notification-message"']
    ]) {
      const start = source.indexOf(from), end = source.indexOf(to, start);
      assert(start >= 0 && end > start, from); vm.runInContext(source.slice(start, end), c);
    }
    c.sendDotSnapshot = () => {};
    await c.refreshTasks();
    c.preparePanel();
    await waitFor(() => c.panelRendererReady && c.panelRenderedRevision === c.panelRenderRevision);
    assert.equal(c.panelWindow.isVisible(), false);
    assert.equal(c.speedDisplayTimer, null);
    // No fs.watch is installed. The only change detection is the production
    // ten-second source check, while the real renderer remains hidden.
    const appendedAt = Date.now();
    fs.appendFileSync(transcript, record(appendedAt, usage(900, 600))
      + record(appendedAt, { type: "agent_message", message: "关闭面板期间收到的最新任务进展" }));
    await waitFor(() => c.snapshot.tasks[0]?.progress === "关闭面板期间收到的最新任务进展");
    await waitFor(() => c.snapshot.usage?.week?.value === 900 && c.snapshot.usage?.sessions.fixture?.value === 900);
    await waitFor(() => c.panelRenderedRevision === c.panelRenderRevision);
    report.hiddenSyncMs = Date.now() - appendedAt;
    assert(report.hiddenSyncMs <= 12_000);
    assert.equal(c.lastSpeedSourceCheck.checkedPaths, 1);
    assert.equal(c.speedDisplayTimer, null, "hidden refresh does not start a render clock");
    assert.equal(c.panelSnapshot().tasks[0].speed.text, "30.0 tok/s");
    const readsBeforeOpen = fullReads;
    const point = { x: screen.getPrimaryDisplay().workArea.x + 220, y: 20 };
    c.openPanel({ type: "tray", point });
    await waitFor(() => c.panelWindow.isVisible());
    const content = await c.panelWindow.webContents.executeJavaScript(`({
      total: document.querySelector('.status-speed-value').textContent,
      row: document.querySelector('.status-task-speed-value').textContent,
      progress: document.querySelector('.status-task-update-text').textContent
    })`);
    assert.equal(content.total, "30.0 tok/s"); assert.equal(content.row, "30.0 tok/s");
    assert.equal(content.progress, "关闭面板期间收到的最新任务进展");
    assert.equal(fullReads, readsBeforeOpen, "open never waits for disk or a new sample");
    report.firstOpenLatencyMs = c.panelLastOpenLatencyMs; report.firstOpen = content;
    report.reopenLatencyMs = [];
    for (let i = 0; i < 5; i++) {
      c.closePanel(); c.openPanel({ type: "tray", point });
      await waitFor(() => c.panelWindow.isVisible());
      report.reopenLatencyMs.push(c.panelLastOpenLatencyMs);
    }
    assert.equal(c.speedSourceCheckIntervalMs(), 3_000);
    const visibleAt = Date.now();
    const expectedSpeed = (
      (now - 15000 > visibleAt - 30000 ? 300 : 0)
      + (appendedAt > visibleAt - 30000 ? 600 : 0) + 300
    ) / 30;
    fs.appendFileSync(transcript, record(visibleAt, usage(1200, 300))
      + record(visibleAt, { type: "agent_message", message: "面板打开时收到的新进展" }));
    await waitFor(() => c.snapshot.tasks[0]?.progress === "面板打开时收到的新进展", 4_500);
    await waitFor(() => c.snapshot.usage?.week?.value === 1200 && c.snapshot.usage?.day?.value === 1200, 4_500);
    await waitFor(() => c.panelRenderedRevision === c.panelRenderRevision);
    report.visibleSyncMs = Date.now() - visibleAt;
    assert(report.visibleSyncMs <= 4_500);
    assert.equal(c.panelWindow.isVisible(), true);
    const shown = await c.panelWindow.webContents.executeJavaScript(`({
      total: document.querySelector('.status-speed-value').textContent,
      row: document.querySelector('.status-task-speed-value').textContent,
      progress: document.querySelector('.status-task-update-text').textContent
    })`);
    assert.deepEqual(shown, { total: expectedSpeed.toFixed(1) + " tok/s",
      row: expectedSpeed.toFixed(1) + " tok/s", progress: "面板打开时收到的新进展" });
    assert.equal(await c.panelWindow.webContents.executeJavaScript("document.querySelector('.status-task-usage').textContent"), "累计 1.2K Token");
    const beforeQuiet = { checks: c.speedSourceCheckCount, reads: fullReads, revision: c.panelRenderRevision };
    await waitFor(() => c.speedSourceCheckCount > beforeQuiet.checks && !c.lastSpeedSourceCheck.changed, 4_500);
    assert.equal(fullReads, beforeQuiet.reads, "a visible quiet check does not read session contents or SQLite");
    assert.equal(c.panelRenderRevision, beforeQuiet.revision, "a visible quiet check does not repaint unchanged data");
    report.visibleQuietCheckSkippedRefreshAndRender = true;
    c.closePanel();
    assert.equal(c.speedSourceCheckIntervalMs(), 10_000);
    const stopAt = Date.now();
    fs.appendFileSync(transcript, record(stopAt, { type: "turn_aborted" }));
    await waitFor(() => c.snapshot.runningCount === 0);
    assert.equal(c.speedSourceCheckTimer, null);
    assert.equal(c.panelSnapshot().tokenSpeed.text, "0.0 tok/s");
    assert.equal(c.panelSnapshot().tasks[0].speed.kind, "average");
    assert.equal(c.panelSnapshot().tasks[0].speed.text, (1200000 / (stopAt - startedAt)).toFixed(1) + " tok/s");
    report.stopSyncMs = Date.now() - stopAt; report.sourceChecks = c.speedSourceCheckCount;
    report.fullReads = fullReads; report.noLiveTimerAfterStop = c.speedSourceCheckTimer === null;
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = String(error.stack || error); process.exitCode = 1;
  } finally {
    if (c) {
      c.quitting = true; clearTimeout(c.speedSourceCheckTimer); clearTimeout(c.taskRefreshTimer); clearTimeout(c.usageTimer); c.destroyPanel();
    }
    client?.stop();
    fs.writeFileSync(path.join(reportDir, "result.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, evidence: reportDir }, null, 2));
    fs.rmSync(data, { recursive: true, force: true });
    app.exit(report.passed ? 0 : 1);
  }
});

"use strict";
// Exercise production refresh -> classification -> presentation with synthetic
// worker responses. No filesystem, Codex process or macOS state is touched.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const classification = require("../../ElectronApp/task-classification");
const { formatTrayTaskLine } = require("../../ElectronApp/tray-icon");
const source = fs.readFileSync(path.resolve(__dirname, "../../ElectronApp/main.js"), "utf8");
let response, notifiedReceipts, broadcasts = 0;
const context = { ...classification, Date, Set, Map,
  snapshot: {quota: {available: false, health: "neutral"}, tasks: [], unreadAvailable: false, unreadCount: 0, runningCount: 0},
  refreshingTasks: false, taskRefreshQueued: false, lastTaskSnapshotJSON: "",
  runtimeStatusClient: {statusFor: () => "idle", refreshCandidates() {}},
  TRANSCRIPT_RUNNING_MAX_AGE_MS: 60_000, ACTIVE_DISCOVERY_WINDOW_MS: 60_000,
  ensureTaskDataClient: () => ({refresh: async () => response}),
  cleanDisplayText: text => text, syncTranscriptWatchers() {},
  handleCompletionNotifications: async (_tasks, receipts) => {notifiedReceipts = receipts;},
  broadcastSnapshot: () => {broadcasts++;}, refreshTrayMenu() {}, sendSettingsSnapshot() {},
  persistResourceDiagnostics() {}, scheduleTaskRefresh() {},
  panelDirection: "down", panelArrowX: 100, effectiveLocale: () => "zh-CN",
  copyFor: () => ({appName: "CodeX状态提醒", unread: "待查看", running: "进行中",
    completed: "已处理", syncing: "待同步", health: {neutral: ["待同步", "待同步"]}})
};
vm.createContext(context);
for (const [from, to] of [["function taskRank(", "function taskDataWorkerResourcesPath("],
  ["async function refreshTasks(", "function scheduleTaskRefresh("],
  ["function dotSnapshot(", "function sendDotSnapshot("]]) {
  const begin = source.indexOf(from), end = source.indexOf(to, begin);
  assert(begin >= 0 && end > begin); vm.runInContext(source.slice(begin, end), context);
}
(async () => {
  response = {rows: [{id: "synthetic-unknown", name: "Synthetic", observation: {isRunning: false,
    latestProgress: "Synthetic result", latestProgressAt: 1, latestCompletedAt: 1}}],
    unread: {available: false, ids: []}};
  await context.refreshTasks();
  assert.equal(context.snapshot.tasks[0]?.state, "unknown");
  assert.equal(notifiedReceipts, null);
  assert.equal(context.panelSnapshot().unreadCount, "–");
  assert.equal(context.panelSnapshot().tasks[0].stateLabel, "待同步");
  assert(context.dotSnapshot().accessibilityLabel.includes("待同步"));
  assert(formatTrayTaskLine({locale: "zh-CN", unreadCount: null, runningCount: 0}).includes("–"));
  const before = broadcasts;
  response.unread = {available: true, ids: ["synthetic-unknown"]};
  await context.refreshTasks();
  assert.equal(context.snapshot.tasks[0].state, "unread");
  assert.equal(context.panelSnapshot().unreadCount, 1);
  assert.equal(context.panelSnapshot().tasks[0].stateLabel, "待查看");
  assert(notifiedReceipts.has("synthetic-unknown"));
  assert.equal(broadcasts, before + 1);
  response.unread = {available: true, ids: []}; await context.refreshTasks();
  assert.equal(context.snapshot.tasks[0].state, "completed");
  assert.equal(context.panelSnapshot().tasks[0].stateLabel, "已处理");
  assert.equal(context.panelSnapshot().unreadCount, 0);
  response.unread = {available: false, ids: []}; await context.refreshTasks();
  assert.equal(context.panelSnapshot().unreadCount, "–");
  assert.equal(context.snapshot.tasks[0].state, "unknown");
  console.log("PASS unread-presentation: worker failure/recovery reaches correct counts, task labels, tray and notification input");
})().catch(error => {console.error(error); process.exitCode = 1;});

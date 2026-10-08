"use strict";

const assert = require("assert/strict");
const {
  isCodexFrontmost,
  normalizeCompletionNotificationState,
  notificationCopy,
  planCompletionNotifications: plan
} = require("../../ElectronApp/completion-notifications");

// Existing fixtures model a successfully read Codex receipt. Tests for an
// unavailable read set must pass null explicitly, as the production app does.
function planCompletionNotifications(input) {
  return plan({
    ...input,
    unreadThreadIDs: input.unreadThreadIDs === undefined
      ? (input.tasks || []).filter((task) => task.state === "unread").map((task) => task.id)
      : input.unreadThreadIDs
  });
}

const startedAt = Date.UTC(2026, 7, 15, 4, 0, 0);
const existingTask = {
  id: "existing",
  title: "已有待查看任务",
  progress: "这是安装前已经完成的任务",
  state: "unread",
  completedAt: startedAt - 60_000,
  locale: "zh-CN"
};

const baseline = planCompletionNotifications({
  tasks: [existingTask],
  state: null,
  now: startedAt,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: false
});
assert.equal(baseline.notifications.length, 0, "首次启动不得推送现有待查看任务");
assert.equal(baseline.state.completions.existing, existingTask.completedAt);

const completedAt = startedAt + 20_000;
const newTask = {
  id: "new-task",
  title: "整理完成报告",
  progress: "已完成构建、签名和运行态验证。",
  state: "unread",
  completedAt,
  locale: "zh-CN"
};
const backgroundResult = planCompletionNotifications({
  tasks: [newTask],
  state: baseline.state,
  now: completedAt + 1_000,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: false
});
assert.deepEqual(backgroundResult.notifications, [{
  threadID: "new-task",
  completedAt,
  title: "整理完成报告",
  body: "已完成构建、签名和运行态验证。"
}]);
assert.equal(
  backgroundResult.state.pending["new-task"],
  completedAt,
  "新完成任务必须进入持久待查看队列"
);

const duplicate = planCompletionNotifications({
  tasks: [newTask],
  state: backgroundResult.state,
  now: completedAt + 2_000,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: false
});
assert.equal(duplicate.notifications.length, 0, "同一次完成不得重复推送");
assert.equal(
  duplicate.state.pending["new-task"],
  completedAt,
  "未打开会话时持久通知不能被清掉"
);

const secondTask = {
  id: "second-task",
  title: "第二个完成任务",
  progress: "第二个任务也已经完成。",
  state: "unread",
  completedAt: completedAt + 1_000,
  locale: "zh-CN"
};
const multipleResult = planCompletionNotifications({
  tasks: [newTask, secondTask],
  state: baseline.state,
  now: completedAt + 2_000,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: false
});
assert.equal(
  multipleResult.notifications.length,
  2,
  "同一轮完成的多个任务必须分别产生通知"
);
assert.deepEqual(
  Object.keys(multipleResult.state.pending).sort(),
  ["new-task", "second-task"],
  "多个任务必须同时保留在待查看队列"
);

const openedResult = planCompletionNotifications({
  tasks: [{ ...newTask, state: "completed" }],
  state: backgroundResult.state,
  now: completedAt + 3_000,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: false
});
assert.equal(
  Object.hasOwn(openedResult.state.pending, "new-task"),
  false,
  "Codex 直接打开会话后必须清除对应持久通知"
);
const openedMissingRowResult = planCompletionNotifications({
  tasks: [],
  unreadThreadIDs: [],
  state: backgroundResult.state,
  now: completedAt + 3_500,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: false
});
assert.equal(
  Object.hasOwn(openedMissingRowResult.state.pending, "new-task"),
  false,
  "即使会话不在当前任务页，Codex 未读集合移除后也必须清除通知"
);

const foregroundTask = { ...newTask, id: "foreground-task", completedAt: completedAt + 5_000 };
const foregroundResult = planCompletionNotifications({
  tasks: [foregroundTask],
  state: backgroundResult.state,
  now: completedAt + 6_000,
  sessionStartedAt: startedAt,
  enabled: true,
  codexFrontmost: true
});
assert.equal(foregroundResult.notifications.length, 0, "Codex 位于前台时不得推送");
assert.equal(
  foregroundResult.state.completions["foreground-task"],
  foregroundTask.completedAt,
  "前台完成任务应记为已处理，切到后台后不得补发"
);

const disabledTask = { ...newTask, id: "disabled-task", completedAt: completedAt + 10_000 };
const disabledResult = planCompletionNotifications({
  tasks: [disabledTask],
  state: foregroundResult.state,
  now: completedAt + 11_000,
  sessionStartedAt: startedAt,
  enabled: false,
  codexFrontmost: false
});
assert.equal(disabledResult.notifications.length, 0, "关闭通知后不得推送");

assert.equal(isCodexFrontmost("com.openai.codex"), true);
assert.equal(isCodexFrontmost("com.openai.chat"), false);
assert.equal(isCodexFrontmost("com.openai.chat", ["com.openai.chat"]), true);
assert.equal(isCodexFrontmost("com.apple.finder"), false);
assert.equal(isCodexFrontmost(""), null);
assert.deepEqual(notificationCopy({}, "en"), {
  title: "Codex task",
  body: "Open Codex to review the result."
});
assert.equal(
  normalizeCompletionNotificationState({ completions: { good: 12, bad: "x" } })
    .completions.good,
  12
);
assert.equal(
  normalizeCompletionNotificationState({ pending: { good: 12, bad: "x" } })
    .pending.good,
  12
);

const unknownForeground = planCompletionNotifications({
  tasks: [newTask], state: baseline.state,
  now: completedAt + 20_000, sessionStartedAt: startedAt, codexFrontmost: null
});
assert.equal(unknownForeground.notifications.length, 0);
assert.equal(unknownForeground.state.completions[newTask.id], undefined,
  "前台状态未知时，超过旧版15秒也不能把完成记录消费掉");
assert.equal(unknownForeground.state.deferred[newTask.id], completedAt);
const unknownMuchLater = planCompletionNotifications({
  tasks: [newTask], state: unknownForeground.state,
  now: completedAt + 3_600_000, sessionStartedAt: startedAt, codexFrontmost: null
});
assert.equal(unknownMuchLater.state.completions[newTask.id], undefined,
  "系统前台信息不可用，不是任务已查看的证据");
const recoveredAfterRestart = planCompletionNotifications({
  tasks: [newTask], state: unknownMuchLater.state,
  now: completedAt + 3_601_000, sessionStartedAt: completedAt + 3_600_000,
  codexFrontmost: false
});
assert.equal(recoveredAfterRestart.notifications.length, 1,
  "待判断完成记录应跨重启保留，并在前台读取恢复后发送一次");
assert.equal(recoveredAfterRestart.state.deferred[newTask.id], undefined);

const unknownUnread = planCompletionNotifications({
  tasks: [{ ...newTask, state: "completed" }], state: baseline.state,
  unreadThreadIDs: null, now: completedAt + 3_600_000,
  sessionStartedAt: startedAt, codexFrontmost: false
});
assert.equal(unknownUnread.state.completions[newTask.id], undefined,
  "未读数据不可用不能被当成已读");
const recoveredUnread = planCompletionNotifications({
  tasks: [newTask], state: unknownUnread.state,
  now: completedAt + 3_601_000, sessionStartedAt: startedAt, codexFrontmost: false
});
assert.equal(recoveredUnread.notifications.length, 1);
const keepPendingOnReadFailure = planCompletionNotifications({
  tasks: [{ ...newTask, state: "completed" }], state: backgroundResult.state,
  unreadThreadIDs: null, now: completedAt + 4_000, codexFrontmost: false
});
assert.equal(keepPendingOnReadFailure.state.pending[newTask.id], completedAt,
  "已展示的提醒不能因未读读取失败而被自动关闭");

const laggingReceipt = planCompletionNotifications({
  tasks: [{ ...newTask, state: "completed" }], state: baseline.state,
  now: completedAt + 30_000, sessionStartedAt: startedAt, codexFrontmost: false
});
assert.equal(laggingReceipt.state.deferred[newTask.id], completedAt);
const receiptArrives = planCompletionNotifications({
  tasks: [newTask], state: laggingReceipt.state,
  now: completedAt + 60_000, sessionStartedAt: startedAt, codexFrontmost: false
});
assert.equal(receiptArrives.notifications.length, 1,
  "任务完成和未读标记不是同一时刻写入，延迟到达也应正常提醒");
const genuinelyRead = planCompletionNotifications({
  tasks: [{ ...newTask, state: "completed" }], state: laggingReceipt.state,
  now: completedAt + 10 * 60_000, sessionStartedAt: startedAt, codexFrontmost: false
});
assert.equal(genuinelyRead.notifications.length, 0);
assert.equal(genuinelyRead.state.deferred[newTask.id], undefined);
assert.equal(genuinelyRead.state.completions[newTask.id], completedAt,
  "确认已读且宽限期已结束后，不保留过期提醒候选");

const disabledDeferred = planCompletionNotifications({
  tasks: [], state: unknownForeground.state, enabled: false,
  now: completedAt + 60_000, codexFrontmost: false
});
assert.equal(disabledDeferred.state.deferred[newTask.id], undefined);
assert.equal(disabledDeferred.state.completions[newTask.id], completedAt);
const closedManually = planCompletionNotifications({
  tasks: [newTask], state: { ...backgroundResult.state, pending: {} },
  now: completedAt + 5_000, codexFrontmost: false
});
assert.equal(closedManually.notifications.length, 0,
  "手动关闭只移除提醒，不会再次发送同一次任务完成");
const foregroundAfterUnknown = planCompletionNotifications({
  tasks: [newTask], state: unknownForeground.state,
  now: completedAt + 60_000, sessionStartedAt: startedAt, codexFrontmost: true
});
assert.equal(foregroundAfterUnknown.notifications.length, 0);
assert.equal(foregroundAfterUnknown.state.deferred[newTask.id], undefined);
const secondCompletion = planCompletionNotifications({
  tasks: [{ ...newTask, completedAt: completedAt + 120_000 }],
  state: { ...backgroundResult.state, pending: {} },
  now: completedAt + 121_000, sessionStartedAt: startedAt, codexFrontmost: false
});
assert.equal(secondCompletion.notifications.length, 1,
  "同一会话新一轮完成应再次提醒，不受上一轮手动关闭影响");
const normalizedDeferred = normalizeCompletionNotificationState({
  completions: { done: 20 }, deferred: { done: 20, newer: 30, bad: "x" }
});
assert.deepEqual(normalizedDeferred.deferred, { newer: 30 });
assert.equal(normalizedDeferred.version, 4);
const boundedCandidates = planCompletionNotifications({
  tasks: Array.from({length: 150}, (_, i) => ({...newTask, id: `deferred-${i}`})),
  state: baseline.state, now: completedAt + 20_000,
  sessionStartedAt: startedAt, codexFrontmost: null
});
assert.equal(Object.keys(boundedCandidates.state.deferred).length, 100,
  "待判断队列必须有界，避免无上限保留内存与状态");

console.log("PASS completion-notifications: delivery, retries, receipts, restart, foreground, deduplication, bounds");

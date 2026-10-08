"use strict";

const MAX_COMPLETION_CURSORS = 500;
const MAX_PENDING_NOTIFICATIONS = 100;
// Give Codex read receipts time to follow the transcript completion. Only a
// known, successfully read negative receipt can expire this grace period.
const UNREAD_SETTLE_MS = 10 * 60_000;
const SESSION_CLOCK_SKEW_MS = 5_000;

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : 0;
}

function normalizeCompletionNotificationState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const completions = {};
  const pending = {};
  const deferred = {};
  if (source.completions && typeof source.completions === "object") {
    for (const [threadID, completionAt] of Object.entries(source.completions)) {
      const timestamp = finiteTimestamp(completionAt);
      if (threadID && timestamp > 0) completions[threadID] = timestamp;
    }
  }
  if (source.pending && typeof source.pending === "object") {
    for (const [threadID, completionAt] of Object.entries(source.pending)) {
      const timestamp = finiteTimestamp(completionAt);
      if (threadID && timestamp > 0) pending[threadID] = timestamp;
    }
  }
  if (source.deferred && typeof source.deferred === "object") {
    for (const [threadID, completionAt] of Object.entries(source.deferred)) {
      const timestamp = finiteTimestamp(completionAt);
      if (threadID && timestamp > finiteTimestamp(completions[threadID])) {
        deferred[threadID] = timestamp;
      }
    }
  }
  return {
    version: 3,
    initialized: source.initialized === true,
    completions,
    pending,
    deferred,
    updatedAt: finiteTimestamp(source.updatedAt)
  };
}

function pruneCompletionCursors(completions, limit = MAX_COMPLETION_CURSORS) {
  return Object.fromEntries(
    Object.entries(completions)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
  );
}

function prunePendingNotifications(
  pending,
  limit = MAX_PENDING_NOTIFICATIONS
) {
  return Object.fromEntries(
    Object.entries(pending)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
  );
}

function notificationCopy(task, locale = "zh-CN") {
  const fallbackTask = locale === "en" ? "Codex task" : "Codex 会话";
  const fallbackProgress = locale === "en"
    ? "Open Codex to review the result."
    : "打开 Codex 查看任务结果。";
  return {
    title: String(task?.title || fallbackTask).trim() || fallbackTask,
    body: String(task?.progress || fallbackProgress).trim() || fallbackProgress
  };
}

function planCompletionNotifications({
  tasks = [],
  state,
  now = Date.now(),
  sessionStartedAt = now,
  enabled = true,
  codexFrontmost = null,
  unreadThreadIDs = null
} = {}) {
  const previous = normalizeCompletionNotificationState(state);
  const initialPass = !previous.initialized;
  const completions = { ...previous.completions };
  const pending = { ...previous.pending };
  const deferred = { ...previous.deferred };
  const notifications = [];
  const unreadSet = unreadThreadIDs instanceof Set
    ? unreadThreadIDs
    : Array.isArray(unreadThreadIDs)
      ? new Set(unreadThreadIDs.filter((id) => typeof id === "string"))
      : null;

  // Only a successfully read Codex receipt can dismiss a persistent banner.
  // A fallback task classification when the read set is unavailable is not
  // evidence that the user viewed the result.
  for (const threadID of Object.keys(pending)) {
    if (unreadSet && !unreadSet.has(threadID)) {
      delete pending[threadID];
      continue;
    }
  }
  if (!enabled) {
    for (const threadID of Object.keys(pending)) delete pending[threadID];
    // Disabling reminders consumes waiting completions, so enabling again
    // cannot backfill notifications the user explicitly chose not to receive.
    for (const [threadID, completionAt] of Object.entries(deferred)) {
      completions[threadID] = Math.max(completions[threadID] || 0, completionAt);
      delete deferred[threadID];
    }
  }

  for (const task of tasks) {
    if (!task?.id) continue;
    const completionAt = finiteTimestamp(task.completedAt);
    if (completionAt <= 0) continue;
    const hasCursor = Object.hasOwn(completions, task.id);
    const previousCompletionAt = finiteTimestamp(completions[task.id]);
    if (completionAt <= previousCompletionAt) continue;

    const completedDuringSession = completionAt >= sessionStartedAt - SESSION_CLOCK_SKEW_MS;
    const wasDeferred = finiteTimestamp(deferred[task.id]) === completionAt;
    const staleUnknownTask = !hasCursor && !completedDuringSession && !wasDeferred;
    if ((initialPass && !wasDeferred) || staleUnknownTask || !enabled || codexFrontmost === true) {
      completions[task.id] = completionAt;
      delete pending[task.id];
      delete deferred[task.id];
      continue;
    }

    if (unreadSet?.has(task.id) && task.state === "unread" && codexFrontmost === false) {
      notifications.push({
        threadID: task.id,
        completedAt: completionAt,
        ...notificationCopy(task, task.locale)
      });
      completions[task.id] = completionAt;
      pending[task.id] = completionAt;
      delete deferred[task.id];
      continue;
    }

    // Unknown foreground/read-receipt state is retryable, not a terminal
    // decision. Persist the candidate across restarts without polling faster.
    deferred[task.id] = completionAt;
    if (codexFrontmost === false && unreadSet
        && now - completionAt >= UNREAD_SETTLE_MS) {
      completions[task.id] = completionAt;
      delete deferred[task.id];
    }
  }

  return {
    state: {
      version: 3,
      initialized: true,
      completions: pruneCompletionCursors(completions),
      pending: prunePendingNotifications(pending),
      deferred: prunePendingNotifications(deferred),
      updatedAt: Math.round(now)
    },
    notifications,
    pending: prunePendingNotifications(pending)
  };
}

function isCodexFrontmost(bundleIdentifier, additionalBundleIdentifiers = []) {
  if (typeof bundleIdentifier !== "string" || !bundleIdentifier.trim()) return null;
  return new Set([
    "com.openai.codex",
    "com.openai.chat",
    ...additionalBundleIdentifiers.filter((value) => typeof value === "string")
  ]).has(bundleIdentifier.trim());
}

module.exports = {
  MAX_COMPLETION_CURSORS,
  MAX_PENDING_NOTIFICATIONS,
  UNREAD_SETTLE_MS,
  isCodexFrontmost,
  normalizeCompletionNotificationState,
  notificationCopy,
  planCompletionNotifications,
  prunePendingNotifications,
  pruneCompletionCursors
};

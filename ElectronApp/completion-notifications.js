"use strict";

const MAX_COMPLETION_CURSORS = 500;
const MAX_PENDING_NOTIFICATIONS = 100;
// Give Codex read receipts time to follow the transcript completion. Only a
// known, successfully read negative receipt can expire this grace period.
const UNREAD_SETTLE_MS = 10 * 60_000;

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.round(timestamp) : 0;
}

function normalizeCompletionNotificationState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const completions = {};
  const pending = {};
  const deferred = {};
  const pendingContent = {};
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
  for (const [threadID, content] of Object.entries(source.pendingContent || {})) {
    if (!Object.hasOwn(pending, threadID)
        || finiteTimestamp(content?.completedAt) !== pending[threadID]) continue;
    pendingContent[threadID] = {
      completedAt: pending[threadID],
      title: String(content.title || "").slice(0, 240),
      body: String(content.body || "").slice(0, 320)
    };
  }
  return {
    version: 4,
    initialized: source.initialized === true,
    completions,
    pending,
    deferred,
    pendingContent,
    remindersEnabled: typeof source.remindersEnabled === "boolean"
      ? source.remindersEnabled : null,
    mutedUntilAt: finiteTimestamp(source.mutedUntilAt),
    prunedBeforeAt: finiteTimestamp(source.prunedBeforeAt),
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
  const pendingContent = { ...previous.pendingContent };
  // Retain the end of the muted interval even if no task/index was readable
  // during it. An explicit enable action advances this cutoff immediately.
  const mutedUntilAt = !enabled || previous.remindersEnabled === false
    ? Math.max(previous.mutedUntilAt, finiteTimestamp(now))
    : previous.mutedUntilAt;
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
      delete pendingContent[threadID];
      continue;
    }
  }
  if (!enabled) {
    for (const threadID of Object.keys(pending)) delete pending[threadID];
    for (const threadID of Object.keys(pendingContent)) delete pendingContent[threadID];
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

    const wasDeferred = finiteTimestamp(deferred[task.id]) === completionAt;
    if (!hasCursor && !wasDeferred && completionAt <= previous.prunedBeforeAt) continue;
    const completedDuringSession = completionAt >= sessionStartedAt;
    const staleUnknownTask = !hasCursor && !completedDuringSession && !wasDeferred;
    if ((initialPass && completionAt < sessionStartedAt && !wasDeferred)
        || staleUnknownTask || !enabled || completionAt <= mutedUntilAt
        || codexFrontmost === true) {
      completions[task.id] = completionAt;
      delete pending[task.id];
      delete deferred[task.id];
      delete pendingContent[task.id];
      continue;
    }

    if (unreadSet?.has(task.id) && task.state === "unread" && codexFrontmost === false) {
      const content = {
        threadID: task.id,
        completedAt: completionAt,
        ...notificationCopy(task, task.locale)
      };
      notifications.push(content);
      completions[task.id] = completionAt;
      pending[task.id] = completionAt;
      pendingContent[task.id] = {
        completedAt: completionAt,
        title: content.title.slice(0, 240), body: content.body.slice(0, 320)
      };
      delete deferred[task.id];
      continue;
    }

    // Unknown foreground/read-receipt state is retryable, not a terminal
    // decision. Persist the candidate across restarts without polling faster.
    deferred[task.id] = completionAt;
    if (codexFrontmost === false && unreadSet && !unreadSet.has(task.id)
        && now - completionAt >= UNREAD_SETTLE_MS) {
      completions[task.id] = completionAt;
      delete deferred[task.id];
    }
  }

  const retainedCompletions = pruneCompletionCursors(completions);
  const retainedPending = prunePendingNotifications(pending);
  const prunedBeforeAt = Object.entries(completions).reduce((cutoff, [id, at]) =>
    Object.hasOwn(retainedCompletions, id) ? cutoff : Math.max(cutoff, at),
  previous.prunedBeforeAt);
  return {
    state: {
      version: 4,
      initialized: true,
      completions: retainedCompletions,
      pending: retainedPending,
      deferred: prunePendingNotifications(deferred),
      pendingContent: Object.fromEntries(Object.entries(pendingContent)
        .filter(([id, content]) => retainedPending[id] === content.completedAt)),
      remindersEnabled: enabled,
      mutedUntilAt,
      prunedBeforeAt,
      updatedAt: Math.round(now)
    },
    notifications: notifications.filter(content =>
      retainedPending[content.threadID] === content.completedAt),
    pending: retainedPending
  };
}

function isCodexFrontmost(bundleIdentifier, additionalBundleIdentifiers = []) {
  if (typeof bundleIdentifier !== "string" || !bundleIdentifier.trim()) return null;
  return new Set([
    "com.openai.codex",
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

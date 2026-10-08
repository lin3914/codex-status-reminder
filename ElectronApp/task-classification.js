"use strict";

// Codex has used both the coarse `active` state and the more specific phase
// names across desktop releases. All of these phases still represent a task
// that has not reached a terminal state.
const ACTIVE_RUNTIME_STATUSES = new Set([
  "active",
  "running",
  "waitingforapproval",
  "waitingforanswer"
]);

// A terminal status is stronger evidence than a stale local transcript. This
// matters when Codex has already stopped a turn but an older `task_started`
// record is still present in the transcript tail.
const TERMINAL_RUNTIME_STATUSES = new Set([
  "idle",
  "inactive",
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "aborted",
  "interrupted",
  "paused",
  "stopped",
  "failed",
  "error",
  "closed",
  "terminated"
]);

function normalizedRuntimeStatus(status) {
  return String(status || "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .toLowerCase();
}

function isTopLevelThread(row) {
  const threadSource = String(row?.thread_source || row?.threadSource || "")
    .toLowerCase();
  const source = String(row?.source || "").toLowerCase();
  const parentThreadId = row?.parent_thread_id || row?.parentThreadId;
  return !parentThreadId
    && !threadSource.startsWith("subagent")
    && !source.includes("\"subagent\"");
}

function classifyTask({ isUnread, hasOpenTurn, runtimeStatus }) {
  if (isActiveRuntimeStatus(runtimeStatus)) return "running";
  // Do not keep a task in "running" merely because an old transcript still
  // looks open. Codex's explicit terminal state wins; unread then decides
  // whether the stopped task belongs in "待查看" or "已处理".
  if (!isTerminalRuntimeStatus(runtimeStatus) && hasOpenTurn) return "running";
  if (isUnread) return "unread";
  return "completed";
}

function isActiveRuntimeStatus(status) {
  return ACTIVE_RUNTIME_STATUSES.has(normalizedRuntimeStatus(status));
}

function isTerminalRuntimeStatus(status) {
  return TERMINAL_RUNTIME_STATUSES.has(normalizedRuntimeStatus(status));
}

module.exports = {
  classifyTask,
  isActiveRuntimeStatus,
  isTerminalRuntimeStatus,
  isTopLevelThread
};

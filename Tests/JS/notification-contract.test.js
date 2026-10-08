"use strict";

// Independent acceptance cases derived from the user-visible contract, not
// from the planner's branches. All inputs are synthetic and time is explicit.
const assert = require("node:assert/strict");
const { planCompletionNotifications: plan, isCodexFrontmost, UNREAD_SETTLE_MS } =
  require("../../ElectronApp/completion-notifications");
const start = 1_800_000_000_000;
const task = (id, at, state = "unread") => ({ id, completedAt: at, state,
  title: `Synthetic ${id}`, progress: "Synthetic task result", locale: "en" });
const fresh = { initialized: true, completions: {}, pending: {}, deferred: {} };
function run(tasks, state = fresh, options = {}) {
  return plan({ tasks, state, now: start + 60_000, sessionStartedAt: start,
    enabled: true, codexFrontmost: false,
    unreadThreadIDs: new Set(tasks.filter(t => t.state === "unread").map(t => t.id)),
    ...options });
}
const cases = [
  ["an independent ChatGPT app does not count as Codex foreground", () => {
    assert.equal(isCodexFrontmost("com.openai.chat"), false);
    assert.equal(isCodexFrontmost("com.openai.chat", ["com.openai.chat"]), true,
      "a verified Codex carrier may still use that identity");
  }],
  ["first refresh excludes old history but delivers a task completed after startup", () => {
    const result = run([task("old", start - 60_000), task("startup-new", start + 1_000)], null);
    assert.deepEqual(result.notifications.map(n => n.threadID), ["startup-new"]);
    assert.equal(result.state.completions.old, start - 60_000);
  }],
  ["an old task discovered just after the first refresh is still history, not a new completion", () => {
    const initialized = run([], null);
    const lateHistory = run([task("late-history", start - 1_000)], initialized.state);
    assert.equal(lateHistory.notifications.length, 0);
    assert.equal(lateHistory.state.completions["late-history"], start - 1_000);
  }],
  ["turning reminders back on does not backfill a completion never seen while muted", () => {
    const off = run([], fresh, { enabled: false, now: start + 10_000 });
    const on = run([], off.state, { enabled: true, now: start + 40_000 });
    const unseen = run([task("muted-unseen", start + 20_000)], on.state);
    assert.equal(unseen.notifications.length, 0);
    const later = run([task("after-enable", start + 50_000)], unseen.state);
    assert.equal(later.notifications.length, 1);
  }],
  ["a positive unread receipt cannot expire just because a stale task label says running", () => {
    const t = task("lagging-status", start + 1_000, "running");
    const waiting = run([t], fresh, { unreadThreadIDs: new Set([t.id]),
      now: t.completedAt + UNREAD_SETTLE_MS + 1 });
    assert.equal(waiting.state.completions[t.id], undefined);
    assert.equal(waiting.state.deferred[t.id], t.completedAt);
    const settled = run([{ ...t, state: "unread" }], waiting.state,
      { now: t.completedAt + UNREAD_SETTLE_MS + 2 });
    assert.equal(settled.notifications.length, 1);
  }],
  ["an unviewed banner can be restored after restart even while the task index is unavailable", () => {
    const t = task("restart-pending", start + 1_000);
    const sent = run([t]);
    const restarted = run([], JSON.parse(JSON.stringify(sent.state)),
      { sessionStartedAt: start + 80_000, now: start + 80_001, unreadThreadIDs: null });
    assert.equal(restarted.state.pending[t.id], t.completedAt);
    assert.equal(restarted.state.pendingContent?.[t.id]?.title, t.title);
    assert.equal(restarted.state.pendingContent?.[t.id]?.body, t.progress);
    const read = run([], restarted.state, { unreadThreadIDs: new Set() });
    assert.equal(read.state.pendingContent?.[t.id], undefined);
  }],
  ["pause and interruption alone do not produce a false new completion", () => {
    for (const state of ["completed", "unread", "running", "unknown"]) {
      assert.equal(run([task(`not-completed-${state}`, 0, state)]).notifications.length, 0);
    }
  }],
  ["input state remains immutable and a matching read receipt removes exactly its banner", () => {
    const first = run([task("a", start + 1_000), task("b", start + 2_000)]);
    const frozen = JSON.stringify(first.state);
    const next = run([], first.state, { unreadThreadIDs: new Set(["b"]) });
    assert.equal(JSON.stringify(first.state), frozen);
    assert.deepEqual(Object.keys(next.state.pending), ["b"]);
    assert.equal(next.notifications.length, 0);
  }]
];
let failures = 0;
for (const [name, check] of cases) {
  try { check(); console.log("PASS contract: " + name); }
  catch (error) { failures++; console.error("FAIL contract: " + name + "\n" + error.message); }
}
assert.equal(failures, 0, `${failures} independent notification contract failures`);
console.log(`PASS notification-contract: ${cases.length} independently specified cases`);

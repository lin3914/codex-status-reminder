"use strict";
// Deterministic high-volume and state-transition checks. Synthetic data only.
const assert = require("node:assert/strict");
const { planCompletionNotifications: plan, MAX_COMPLETION_CURSORS,
  MAX_PENDING_NOTIFICATIONS, normalizeCompletionNotificationState } =
  require("../../ElectronApp/completion-notifications");
const start = 1_800_000_000_000;
const tasks = Array.from({length: 600}, (_, i) => ({
  id: `synthetic-pressure-${i}`, completedAt: start + i + 1,
  state: "unread", title: "T".repeat(300), progress: "B".repeat(500)
}));
const receipt = new Set(tasks.map(t => t.id));
const run = (rows, state, options = {}) => plan({tasks: rows, state,
  sessionStartedAt: start, now: start + 10_000, enabled: true,
  codexFrontmost: false, unreadThreadIDs: receipt, ...options});
const fresh = { initialized: true };
const first = run(tasks, fresh);
assert.equal(first.notifications.length, MAX_PENDING_NOTIFICATIONS);
assert.equal(Object.keys(first.state.completions).length, MAX_COMPLETION_CURSORS);
assert.equal(Object.keys(first.state.pending).length, MAX_PENDING_NOTIFICATIONS);
assert.equal(Object.keys(first.state.pendingContent).length, MAX_PENDING_NOTIFICATIONS);
assert(first.notifications.every(n => Number(n.threadID.split("-").at(-1)) >= 500));
assert(Object.values(first.state.pendingContent).every(c => c.title.length === 240 && c.body.length === 320));
let state = first.state;
for (let i = 0; i < 50; i++) {
  const result = run([...tasks].reverse(), state, { now: start + 20_000 + i });
  assert.equal(result.notifications.length, 0, "pruned cursors must not resurrect old reminders");
  state = JSON.parse(JSON.stringify(result.state));
}
const waiting = { ...state, deferred: { "late-receipt": start + 20 } };
const deferred = run([{id: "late-receipt", state: "unread", completedAt: start + 20}], waiting,
  { unreadThreadIDs: new Set(["late-receipt"]) });
assert.equal(deferred.notifications.length, 1, "retained deferred candidates survive the pruning watermark");
console.log("PASS pressure: 600 simultaneous completions retain latest 100, 500 cursors and no duplicate backfill");

// A reproducible sequence of starts, completions, refreshes, receipt failures,
// manual dismissal, mute/enable, and serialized process restarts.
let seed = 0x6a913f;
const random = limit => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % limit; };
const rows = new Map(), unread = new Set(), delivered = new Set();
state = normalizeCompletionNotificationState({initialized: true});
let clock = start + 1_000, enabled = true;
for (let i = 0; i < 2_000; i++) {
  clock += 10;
  const id = `synthetic-sequence-${random(80)}`;
  switch (random(7)) {
    case 0: rows.set(id, {id, completedAt: clock, state: "unread", title: id, progress: "Synthetic"}); unread.add(id); break;
    case 1: unread.delete(id); if (rows.has(id)) rows.get(id).state = "completed"; break;
    case 2: if (rows.has(id)) rows.get(id).state = "running"; break;
    case 3: if (rows.has(id) && unread.has(id)) rows.get(id).state = "unread"; break;
    case 4: state = JSON.parse(JSON.stringify(state)); break;
    case 5: delete state.pending[id]; delete state.pendingContent[id]; break;
    case 6: enabled = !enabled; break;
  }
  const foreground = random(5) === 0 ? null : random(5) === 0;
  const receipts = random(6) === 0 ? null : new Set(unread);
  const before = JSON.stringify(state);
  const result = run([...rows.values()], state, {now: clock, enabled,
    codexFrontmost: foreground, unreadThreadIDs: receipts});
  assert.equal(JSON.stringify(state), before, "planner must not mutate inputs");
  for (const n of result.notifications) {
    assert(enabled && foreground === false && receipts?.has(n.threadID));
    assert.equal(rows.get(n.threadID).state, "unread");
    const key = `${n.threadID}:${n.completedAt}`;
    assert(!delivered.has(key), "one completion must not be requested twice");
    delivered.add(key);
    assert.equal(result.state.pending[n.threadID], n.completedAt);
  }
  assert(Object.keys(result.state.completions).length <= MAX_COMPLETION_CURSORS);
  assert(Object.keys(result.state.pending).length <= MAX_PENDING_NOTIFICATIONS);
  assert(Object.keys(result.state.deferred).length <= MAX_PENDING_NOTIFICATIONS);
  assert(Object.keys(result.state.pendingContent).every(id =>
    result.state.pending[id] === result.state.pendingContent[id].completedAt));
  if (!enabled) assert.equal(Object.keys(result.state.pending).length, 0);
  if (receipts) assert(Object.keys(result.state.pending).every(id => receipts.has(id)));
  state = result.state;
}
console.log(`PASS pressure: 2000 seeded transitions, ${delivered.size} distinct delivery requests, bounded state and immutable inputs`);

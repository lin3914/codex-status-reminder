"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { TaskDataReader } = require("../../ElectronApp/task-data-worker");
const { speedPanel, nextSpeedUpdateDelay } = require("../../ElectronApp/token-speed");

const source = fs.readFileSync(path.join(__dirname, "../../ElectronApp/main.js"), "utf8");
const start = source.indexOf("function speedSourceCheckIntervalMs()");
const end = source.indexOf("\nfunction scheduleSpeedDisplay()", start);
assert(start >= 0 && end > start);

function harness() {
  let now = 1_000;
  const timers = new Set(), requests = [];
  const ctx = {
    quitting: false, systemSleeping: false, screenLocked: false,
    speedSourceCheckTimer: null, speedSourceCheckInFlight: false,
    speedSourceCheckCount: 0, lastSpeedSourceCheck: null,
    refreshingTasks: false, taskRefreshTimer: null,
    panelWindow: null,
    Date: { now: () => now },
    snapshot: { tasks: [] },
    taskDataClient: { async checkActive(ids) {
      requests.push(ids);
      return { changed: false, checkedPaths: ids.length, durationMs: 0 };
    } },
    setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); },
    scheduleTaskRefresh(delay, reason) { ctx.refreshes.push({ delay, reason }); },
    refreshes: []
  };
  vm.createContext(ctx);
  vm.runInContext(source.match(/^const SPEED_(?:VISIBLE_)?SOURCE_CHECK_MS = [\d_]+;$/gm).join("\n"), ctx);
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, timers, requests, async fire(expectedMs = 10_000) {
    const timer = ctx.speedSourceCheckTimer;
    assert(timers.delete(timer));
    assert.equal(timer.ms, expectedMs);
    now += timer.ms;
    await timer.fn();
  } };
}

async function checkScheduler() {
  const h = harness(), c = h.ctx;
  c.scheduleSpeedSourceCheck();
  assert.equal(h.timers.size, 0, "idle has no heartbeat");
  c.snapshot.tasks = [{ id: "active", state: "running" }, { id: "ended", state: "completed" }];
  c.scheduleSpeedSourceCheck();
  assert.equal(h.timers.size, 1, "one hidden-panel heartbeat, independent of renderers");
  const first = c.speedSourceCheckTimer;
  c.scheduleSpeedSourceCheck();
  assert(!h.timers.has(first), "fresh event-driven data postpones the redundant check");
  assert.equal(h.timers.size, 1);
  for (let i = 0; i < 12; i++) await h.fire();
  assert.equal(h.requests.length, 12, "no more than one metadata check per ten quiet seconds");
  assert(h.requests.every(ids => ids.length === 1 && ids[0] === "active"));
  assert.equal(c.refreshes.length, 0, "unchanged metadata triggers no database refresh or renderer message");
  assert.equal(h.timers.size, 1);
  let visible = true;
  c.panelWindow = { isDestroyed: () => false, isVisible: () => visible };
  c.scheduleSpeedSourceCheck();
  assert.equal(h.timers.size, 1, "opening replaces the background timer, rather than adding another");
  await h.fire(3_000);
  await h.fire(3_000);
  assert.equal(h.requests.length, 14);
  assert.equal(c.refreshes.length, 0, "visible quiet checks still skip full refresh");
  visible = false;
  c.scheduleSpeedSourceCheck();
  assert.equal(c.speedSourceCheckTimer.ms, 10_000, "a retained hidden renderer returns to the background cadence");
  c.refreshingTasks = true;
  await h.fire();
  assert.equal(h.requests.length, 14, "coalesce with an existing full refresh");
  c.refreshingTasks = false;
  c.taskDataClient.checkActive = async () => ({ changed: true, checkedPaths: 1, durationMs: 0 });
  await h.fire();
  assert.equal(c.refreshes.length, 1);
  assert.equal(c.refreshes[0].delay, 0);
  assert.equal(c.refreshes[0].reason, "speed-source-check");
  c.snapshot.tasks = [{ id: "active", state: "completed" }];
  c.scheduleSpeedSourceCheck();
  assert.equal(h.timers.size, 0, "stopped tasks remove the heartbeat");
  c.snapshot.tasks[0].state = "running";
  for (const flag of ["systemSleeping", "screenLocked", "quitting"]) {
    c[flag] = true; c.scheduleSpeedSourceCheck();
    assert.equal(h.timers.size, 0, flag + " cancels pending checks");
    c[flag] = false;
  }
  let resolve;
  c.taskDataClient.checkActive = () => new Promise(r => { resolve = r; });
  c.scheduleSpeedSourceCheck();
  const pending = h.fire();
  c.scheduleSpeedSourceCheck();
  assert.equal(h.timers.size, 0, "slow workers never overlap requests");
  c.screenLocked = true;
  resolve({ changed: true }); await pending;
  assert.equal(c.refreshes.length, 1, "discard a late response after lock");
  assert.equal(h.timers.size, 0);
  c.screenLocked = false;
  c.taskDataClient.checkActive = async () => { throw new Error("worker fixture failure"); };
  c.scheduleSpeedSourceCheck(); await h.fire();
  assert.equal(h.timers.size, 1, "failures keep bounded retry, not a tight loop");
  c.quitting = true; c.scheduleSpeedSourceCheck();
}

function checkWorkerAndColdOpen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-check-"));
  let reader;
  try {
    const now = Date.now(), globalStatePath = path.join(dir, ".codex-global-state.json");
    const record = (at, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload }) + "\n";
    const usage = total => ({ type: "token_count", info: {
      total_token_usage: { output_tokens: total }, last_token_usage: { output_tokens: total }
    } });
    const transcript = path.join(dir, "active.jsonl");
    fs.writeFileSync(transcript, record(now - 20_000, { type: "task_started" })
      + record(now - 15_000, usage(300)));
    fs.writeFileSync(globalStatePath, JSON.stringify({ "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": { local: [] }
    } }));
    const db = new DatabaseSync(path.join(dir, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, name TEXT, preview TEXT, thread_source TEXT, source TEXT, cwd TEXT, agent_path TEXT)");
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 0, 'Synthetic', '', 'cli', '', '', '')");
    insert.run("active", transcript, now, now);
    for (let i = 0; i < 80; i++) {
      const file = path.join(dir, `ended-${i}.jsonl`);
      fs.writeFileSync(file, record(now - 1000, { type: "task_complete", duration_ms: 1000 }));
      insert.run(`ended-${i}`, file, now - 1000, now - 1000);
    }
    db.close();
    reader = new TaskDataReader({ codexHome: dir, globalStatePath });
    reader.refresh();
    const originalPrepare = reader.database.prepare;
    const originalRead = fs.readFileSync, originalRange = reader.transcripts.readRange;
    const originalStat = fs.statSync;
    let statCount = 0;
    reader.database.prepare = () => { throw new Error("heartbeat must not query SQLite"); };
    fs.readFileSync = () => { throw new Error("heartbeat must not read auth, unread or transcript contents"); };
    reader.transcripts.readRange = () => { throw new Error("heartbeat must not read transcript bytes"); };
    fs.statSync = (...args) => { statCount++; assert.equal(args[0], transcript); return originalStat(...args); };
    try {
      assert.equal(reader.checkActive(["active", "active", "not-known"]).changed, false);
      assert.equal(statCount, 1, "only known active path, duplicate IDs deduplicated");
      const snapshotBefore = JSON.stringify(reader.transcripts.cache.get(transcript).observation);
      for (let i = 0; i < 1000; i++) assert.equal(reader.checkActive(["active"]).changed, false);
      assert.equal(JSON.stringify(reader.transcripts.cache.get(transcript).observation), snapshotBefore,
        "metadata probes neither copy nor mutate cached samples");
    } finally {
      reader.database.prepare = originalPrepare; fs.readFileSync = originalRead;
      reader.transcripts.readRange = originalRange; fs.statSync = originalStat;
    }
    // Simulate a missed fs.watch callback. No panel has been opened or created.
    fs.appendFileSync(transcript, record(now - 5000, usage(900))
      + record(now - 5000, { type: "agent_message", message: "Newest progress remains available" }));
    assert.equal(reader.checkActive(["active"]).changed, true);
    const state = reader.refresh().rows.find(row => row.id === "active");
    const tasks = [{ state: "running", tokenSpeed: state.observation.tokenSpeed }];
    for (const seconds of [30, 60, 300]) {
      assert.equal(speedPanel(tasks, "en", now, seconds).rows[0].value, 900 / seconds,
        "first open has usable cached samples, with no sampling restart");
    }
    assert.equal(state.observation.latestProgress, "Newest progress remains available");
    assert.equal(reader.checkActive(["active"]).changed, false);
    assert.equal(speedPanel(tasks, "en", now + 31_000).rows[0].value, 30,
      "opening later reuses the last known report rather than restarting sampling");
    assert.equal(speedPanel(tasks, "en", now + 31_000).rows[0].held, true);
    assert.equal(speedPanel(tasks, "en", now + 31_000).rows[0].label, "");
    fs.appendFileSync(transcript, record(now, { type: "turn_aborted" }));
    assert.equal(reader.checkActive(["active"]).changed, true);
    const stopped = reader.refresh().rows.find(row => row.id === "active");
    assert.equal(stopped.observation.isRunning, false, "missed terminal event still exits live status");
    assert.equal(speedPanel([{ state: "completed", tokenSpeed: stopped.observation.tokenSpeed }], "en", now).total.text, "0.0 tok/s");
    const replacement = path.join(dir, "replacement.jsonl");
    fs.writeFileSync(replacement, record(now + 1000, { type: "task_started" }));
    fs.renameSync(replacement, transcript);
    assert.equal(reader.checkActive(["active"]).changed, true, "rotation detected by inode");
    reader.refresh();
    fs.unlinkSync(transcript);
    assert.equal(reader.checkActive(["active"]).changed, true, "deleted active file is reconciled");
  } finally {
    reader?.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkPowerLifecycle() {
  const events = new Map(), refreshes = [];
  const c = {
    menuBarHealthTimer: null, systemSleeping: false, screenLocked: false,
    MENU_BAR_HEALTH_MS: 60_000,
    powerMonitor: { on(name, fn) { events.set(name, fn); } },
    setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }),
    ensureMenuBarTray() {}, scheduleQuotaRefresh() {},
    scheduleSpeedSourceCheck() {}, scheduleSpeedDisplay() {}, scheduleUsageRefresh() {},
    scheduleTaskRefresh(delay, reason) { refreshes.push({ delay, reason }); }
  };
  vm.createContext(c);
  const start = source.indexOf("function startMenuBarLifecycleMonitoring()");
  const end = source.indexOf("async function openMenuBarSystemSettings()", start);
  vm.runInContext(source.slice(start, end), c);
  c.startMenuBarLifecycleMonitoring();
  events.get("lock-screen")(); events.get("suspend")(); events.get("resume")();
  assert.equal(c.systemSleeping, false); assert.equal(c.screenLocked, true);
  assert.equal(refreshes.length, 0, "resume while still locked does not resume active reads");
  events.get("unlock-screen")();
  assert.equal(refreshes.length, 1); assert.equal(refreshes[0].delay, 0);
  events.get("suspend")(); events.get("unlock-screen")();
  assert.equal(refreshes.length, 1, "unlock during suspend must not start reads");
  events.get("resume")(); assert.equal(refreshes.length, 2);
}

(async () => {
  const now = Date.now(), task = { state: "running", tokenSpeed: {
    completeStart: true, samples: [{ at: now - 5000, output: 300 }]
  } };
  assert.equal(nextSpeedUpdateDelay([task], now), null, "unchanged display does not wake just to mark an internal held flag");
  assert.equal(nextSpeedUpdateDelay([task], now, 60), null);
  assert.equal(nextSpeedUpdateDelay([task], now + 31_000), null, "holding a known rate does not start a recurring display timer");
  assert.equal(nextSpeedUpdateDelay([{ ...task, state: "completed" }], now), null);
  assert.equal(nextSpeedUpdateDelay([{ state: "running", tokenSpeed: { samples: [] } }], now), null,
    "waiting for first usage must not spin a display timer");
  assert.equal(nextSpeedUpdateDelay([{ state: "running", tokenSpeed: { samples: [], coverageSince: now - 5000 } }], now), 25001);
  assert.equal(nextSpeedUpdateDelay([{ ...task, tokenSpeed: { ...task.tokenSpeed, invalid: true } }], now), null);
  assert.equal(nextSpeedUpdateDelay([{ state: "running", tokenSpeed: {
    completeStart: true, samples: [{ at: now + 10_000_000_000, output: 1 }]
  } }], now), 300_000, "bad future timestamps cannot overflow setTimeout into a busy loop");
  await checkScheduler();
  checkPowerLifecycle();
  checkWorkerAndColdOpen();
  console.log("PASS token-speed-refresh: 3s visible / 10s hidden active-only metadata checks, cached first open, missed events, terminal, rotation, idle/lock/sleep, no repeated data reads");
})().catch(error => { console.error(error); process.exitCode = 1; });

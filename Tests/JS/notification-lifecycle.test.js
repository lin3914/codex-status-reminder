"use strict";

// Fault injection against the production main-process functions. All windows,
// timers, native notifications and storage are test-owned doubles; no Codex or
// macOS preferences are read or modified by this independent lifecycle test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const completion = require("../../ElectronApp/completion-notifications");
const source = fs.readFileSync(path.resolve(__dirname, "../../ElectronApp/main.js"), "utf8");
const begin = source.indexOf("function discoveredCodexBundleIdentifiers(");
const end = source.indexOf("\nfunction taskRank(", begin);
assert(begin >= 0 && end > begin);
const epoch = 1_800_000_000_000;
const task = { id: "synthetic-lifecycle", state: "unread", completedAt: epoch + 1_000,
  title: "Synthetic completion", progress: "Synthetic result", locale: "en" };

function fixture() {
  let clock = epoch + 2_000;
  const timers = new Map(), windows = [], native = [], stored = [];
  const injection = { load: "ready", constructorFailures: 0, writeFailure: false, supported: true };
  let id = 0;
  class Clock extends Date { static now() { return clock; } }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      if (injection.constructorFailures > 0) { injection.constructorFailures--; throw new Error("synthetic construction failure"); }
      this.options = options; this.destroyed = false; this.visible = false;
      this.webContents = new EventEmitter(); this.messages = [];
      this.webContents.send = (channel, value) => this.messages.push({ channel, value });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    setBounds(value) { this.bounds = value; }
    setBackgroundColor() {} setHasShadow() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
    loadFile() {
      if (injection.load === "failed") return Promise.reject(new Error("synthetic load failure"));
      if (injection.load === "stalled") return new Promise(() => {});
      return Promise.resolve().then(() => this.webContents.emit("did-finish-load"));
    }
  }
  class Native extends EventEmitter {
    static isSupported() { return injection.supported; }
    constructor(options) { super(); this.options = options; native.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit("close"); }
  }
  const context = {
    ...completion, path, BrowserWindow: Window, Notification: Native, Date: Clock,
    __dirname: "/synthetic/app.asar", process: { resourcesPath: "/synthetic/resources" },
    screen: { getCursorScreenPoint: () => ({x: 0, y: 0}),
      getDisplayNearestPoint: () => ({ workArea: {x: 0, y: 0, width: 1440, height: 900} }) },
    console: { error() {}, log() {} }, quitting: false,
    rendererURL: () => "file:///synthetic/notification.html", protectRendererWindow() {},
    resolveCodexExecutable: () => null, appBundleForExecutable: () => null,
    APP_SESSION_STARTED_AT: epoch,
    COMPLETION_NOTIFICATION_STATE_PATH: "/synthetic/state.json",
    completionNotificationState: completion.normalizeCompletionNotificationState({ initialized: true }),
    lastCompletionNotificationStateJSON: null, lastCompletionNotificationDecision: null,
    lastCompletionNotificationPersistenceError: null, lastCompletionBannerFailure: null,
    lastCompletionBannerContentJSON: null, completionBannerRecoveryTimer: null,
    completionBannerFailureTimes: [], completionBannerWindow: null, completionBannerExpanded: false,
    completionBannerEntries: new Map(), completionSystemNotifications: new Map(),
    settings: { notifyOnUnreadCompletion: true }, effectiveLocale: () => "en",
    copyFor: () => ({ appName: "CodeX Status Reminder" }),
    readFrontmostBundleIdentifier: async () => "com.apple.finder",
    writeJSON: (_file, value) => {
      if (injection.writeFailure) throw new Error("synthetic ENOSPC");
      stored.push(JSON.stringify(value));
    },
    shell: { openExternal: async () => {} }, openCodex() {},
    setTimeout: (fn, ms) => { const timer = {id: ++id, unref() {}};
      timers.set(timer.id, {fn, at: clock + ms}); return timer; },
    clearTimeout: timer => timers.delete(timer?.id)
  };
  vm.createContext(context); vm.runInContext(source.slice(begin, end), context);
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const advance = async milliseconds => {
    const until = clock + milliseconds;
    for (let n = 0; n < 100; n++) {
      const next = [...timers].filter(([,t]) => t.at <= until).sort((a,b) => a[1].at-b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
      if (n === 99) throw new Error("unbounded notification timer loop");
    }
    clock = until; await settle();
  };
  const deliver = async (tasks = [task], receipts = new Set(tasks.map(t => t.id))) => {
    await context.handleCompletionNotifications(tasks, receipts); await settle();
  };
  return { context, windows, native, stored, injection, timers, advance, settle, deliver };
}

const cases = [
  ["refreshes preserve the DOM and do not rewrite unchanged persistent state", async () => {
    const f = fixture(); await f.deliver();
    const win = f.context.completionBannerWindow;
    assert(win.isVisible()); assert(win.companionNotificationReady);
    const writes = f.stored.length, sends = win.messages.length;
    for (let n = 0; n < 20; n++) { await f.advance(500); await f.deliver(); }
    assert.equal(f.stored.length, writes); assert.equal(win.messages.length, sends);
  }],
  ["a renderer crash restores the same unviewed reminder, without restarting the app", async () => {
    const f = fixture(); await f.deliver(); const old = f.context.completionBannerWindow;
    old.webContents.emit("render-process-gone", {}, {reason: "crashed"});
    assert(old.isDestroyed()); assert.equal(f.context.completionNotificationState.pending[task.id], task.completedAt);
    await f.advance(350);
    assert.notEqual(f.context.completionBannerWindow, old); assert(f.context.completionBannerWindow.isVisible());
    old.webContents.emit("did-finish-load");
    assert.equal(f.windows.length, 2); assert.equal(f.native.length, 0);
  }],
  ["a load failure preserves pending state and recovers with a fresh renderer", async () => {
    const f = fixture(); f.injection.load = "failed"; await f.deliver();
    assert.equal(f.context.completionBannerWindow, null);
    f.injection.load = "ready"; await f.advance(350);
    assert(f.context.completionBannerWindow.isVisible()); assert.equal(f.windows.length, 2);
  }],
  ["a stalled load stays hidden and recovers after the bounded timeout", async () => {
    const f = fixture(); f.injection.load = "stalled"; await f.deliver();
    assert.equal(f.windows[0].isVisible(), false);
    await f.advance(10_001); assert(f.windows[0].isDestroyed());
    f.injection.load = "ready"; await f.advance(350); assert(f.context.completionBannerWindow.isVisible());
  }],
  ["continuous construction failures have a retry budget and a deduplicated system fallback", async () => {
    const f = fixture(); f.injection.constructorFailures = 100; await f.deliver(); await f.advance(700);
    assert.equal(f.context.completionBannerWindow, null); assert.equal(f.native.length, 1);
    for (let n = 0; n < 20; n++) await f.deliver();
    assert.equal(f.native.length, 1); assert.equal(f.context.completionBannerFailureTimes.length, 3);
    f.injection.constructorFailures = 0; await f.advance(60_001); await f.deliver();
    assert(f.context.completionBannerWindow.isVisible()); assert(f.native[0].closed);
    assert.equal(f.context.completionNotificationState.pending[task.id], task.completedAt);
  }],
  ["system fallback failure keeps the completion and does not create a rapid retry loop", async () => {
    const f = fixture(); f.injection.constructorFailures = 100; await f.deliver(); await f.advance(700);
    f.native[0].emit("failed", {}, "synthetic authorization failure");
    for (let n = 0; n < 20; n++) await f.deliver();
    assert.equal(f.native.length, 1); assert.equal(f.context.completionNotificationState.pending[task.id], task.completedAt);
    assert.equal(f.context.lastCompletionBannerFailure.reason, "system-notification-failed");
  }],
  ["manual system dismissal consumes only the notification, not the Codex unread receipt", async () => {
    const f = fixture(); f.injection.constructorFailures = 100; await f.deliver(); await f.advance(700);
    f.native[0].emit("close");
    assert.equal(f.context.completionNotificationState.pending[task.id], undefined);
    await f.deliver(); assert.equal(f.native.length, 1);
  }],
  ["manual close during recovery cancels resurrection", async () => {
    const f = fixture(); await f.deliver();
    f.context.completionBannerWindow.webContents.emit("render-process-gone", {}, {reason: "crashed"});
    f.context.dismissCompletionBanner(task.id); await f.advance(1_000);
    assert.equal(f.context.completionBannerWindow, null); assert.equal(f.windows.length, 1);
    await f.deliver(); assert.equal(f.windows.length, 1);
  }],
  ["a state write failure does not suppress the banner and persistence is retried", async () => {
    const f = fixture(); f.injection.writeFailure = true; await f.deliver();
    assert(f.context.completionBannerWindow.isVisible()); assert.equal(f.context.lastCompletionNotificationPersistenceError, "write-failed");
    f.injection.writeFailure = false; await f.deliver();
    assert.equal(f.stored.length, 1); assert.equal(f.context.lastCompletionNotificationPersistenceError, null);
    assert.equal(f.windows.length, 1);
  }],
  ["reminder disable while foreground lookup is pending prevents a late popup", async () => {
    const f = fixture(); let resolve;
    f.context.readFrontmostBundleIdentifier = () => new Promise(done => {resolve = done;});
    const pending = f.deliver(); await f.settle();
    f.context.settings.notifyOnUnreadCompletion = false; resolve("com.apple.finder"); await pending;
    assert.equal(f.windows.length, 0); assert.equal(f.context.completionNotificationState.pending[task.id], undefined);
  }],
  ["persisted content restores a card when no task row or read receipt is available", async () => {
    const f = fixture(); await f.deliver();
    const saved = JSON.parse(JSON.stringify(f.context.completionNotificationState));
    f.context.closeAllCompletionBanners(); f.context.completionNotificationState = saved;
    await f.deliver([], null);
    assert(f.context.completionBannerWindow.isVisible());
    assert.equal(f.context.completionBannerEntries.get(task.id).content.title, task.title);
  }],
  ["quitting or disabling reminders during recovery never reopens a card", async () => {
    for (const exit of ["quitting", "disabled"]) {
      const f = fixture(); await f.deliver();
      f.context.completionBannerWindow.webContents.emit("render-process-gone", {}, {reason: "crashed"});
      if (exit === "quitting") f.context.quitting = true;
      else f.context.settings.notifyOnUnreadCompletion = false;
      await f.advance(1_000); assert.equal(f.windows.length, 1);
    }
  }]
];
(async () => {
  let failures = 0;
  for (const [name, test] of cases) {
    try { await test(); console.log("PASS lifecycle: " + name); }
    catch (error) { failures++; console.error("FAIL lifecycle: " + name + "\n" + error.message); }
  }
  assert.equal(failures, 0, `${failures} independent lifecycle failures`);
  console.log(`PASS notification-lifecycle: ${cases.length} independent fault/interaction cases`);
})().catch(error => { console.error(error); process.exitCode = 1; });

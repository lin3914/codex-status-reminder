"use strict";

const assert = require("assert/strict");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { rendererURL, protectRendererWindow, trustedRendererEvent } = require("../../ElectronApp/renderer-security");

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "ElectronApp/main.js"), "utf8");
const html = fs.readFileSync(path.join(root, "Resources/LegacyV11/panel.html"), "utf8");
const functionSource = (name, next) => {
  const start = main.indexOf(`function ${name}(`);
  const end = main.indexOf(`\nfunction ${next}(`, start);
  assert(start >= 0 && end > start, `${name} source must exist`);
  return main.slice(start, end);
};

function harness() {
  let now = 10_000;
  const timers = new Set();
  const windows = [];
  const ipc = new Map();
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { ...options };
      this.visible = false;
      this.destroyed = false;
      this.opacity = 0;
      this.webContents = new EventEmitter();
      this.webContents.messages = [];
      this.webContents.send = (channel, payload) => this.webContents.messages.push({ channel, payload });
      this.webContents.getOSProcessId = () => 500;
      this.webContents.setWindowOpenHandler = (handler) => { this.webContents.openHandler = handler; };
      this.webContents.mainFrame = { url: rendererURL("/app", "panel.html") };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setPosition(x, y, animate) { Object.assign(this.bounds, { x, y, animate }); }
    setOpacity(value) { this.opacity = value; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    loadFile() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  }
  const context = {
    BrowserWindow: Window, path, __dirname: "/app",
    rendererURL, protectRendererWindow, trustedRendererEvent,
    Date: { now: () => now },
    setTimeout(callback, ms) {
      const timer = { callback, ms, unref() { this.unreferenced = true; } };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 800 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 876 } })
    },
    ipcMain: { on: (name, callback) => ipc.set(name, callback) },
    quitting: false,
    panelWindow: null, panelAnchor: null, panelRendererReady: false, panelClockTimer: null,
    panelHiddenSince: null, panelSnapshotJSON: null, panelPresentationID: 0,
    panelPresentationSentKey: null, panelLastFrameLatencyMs: null,
    panelLastRendererMemoryKB: null, panelMemoryReleaseCount: 0, panelPrewarmCount: 0,
    panelRenderRevision: 0, panelRenderedRevision: 0, panelOpenStartedAt: null,
    panelLastOpenLatencyMs: null, panelLastOpenSource: null, panelCreateCount: 0, panelReuseCount: 0,
    panelReportedHeight: 1, panelDirection: "down", panelArrowX: 180,
    hoverOpenTimer: null, hoverCloseTimer: null,
    PANEL_WIDTH: 360, PANEL_MAX_HEIGHT: 400, PANEL_GAP: 2, DOT_SIZE: 44,
    HOVER_OPEN_MS: 80, HOVER_CLOSE_MS: 280,
    PANEL_RENDERER_MEMORY_BUDGET_KB: 192 * 1024, PANEL_MEMORY_RELEASE_IDLE_MS: 60_000,
    rendererMemoryKB: 100 * 1024,
    app: { getAppMetrics: () => [{ pid: 500, memory: { workingSetSize: context.rendererMemoryKB } }] },
    snapshot: { tasks: [{ id: "one" }], value: "original", quota: { available: false } },
    dotWindow: { isDestroyed: () => false, isVisible: () => true,
      getBounds: () => ({ x: 400, y: 300, width: 64, height: 64 }) },
    applyWindowPreferences: () => {},
    panelSnapshot: () => ({ value: context.snapshot.value, direction: context.panelDirection }),
    writeMenuBarRuntime: () => {},
    trayAnchorPoint: () => ({ x: 800, y: 12 }),
    openTask: (id) => { context.openedTask = id; }
  };
  vm.createContext(context);
  vm.runInContext(functionSource("clearHoverOpenTimer", "createSettingsWindow"), context);
  vm.runInContext(functionSource("sendPanelSnapshot", "broadcastSnapshot"), context);
  vm.runInContext(functionSource("toggleTrayPanel", "trayMenuTemplate"), context);
  const ipcStart = main.indexOf('ipcMain.on("companion:panel-message"');
  const ipcEnd = main.indexOf('\nipcMain.on("companion:notification-message"', ipcStart);
  vm.runInContext(main.slice(ipcStart, ipcEnd), context);
  return {
    context, windows, timers,
    advance: (ms) => { now += ms; },
    fire(timer) { assert(timers.delete(timer)); timer.callback(); },
    message(message, win = context.panelWindow) {
      ipc.get("companion:panel-message")({
        sender: win?.webContents, senderFrame: win?.webContents?.mainFrame
      }, message);
    },
    ack(height = 394, revision = context.panelRenderRevision) {
      this.message({ type: "resize", height, renderRevision: revision });
    },
    present(id = context.panelPresentationID, revision = context.panelRenderRevision) {
      this.message({ type: "presented", presentationID: id, renderRevision: revision });
    }
  };
}

const h = harness();
const c = h.context;
// Startup prepares exactly one invisible view before the first user request.
c.preparePanel();
const first = c.panelWindow;
assert.equal(first.visible, false);
h.message({ type: "ready" }, { webContents: {} });
assert.equal(c.panelRendererReady, false, "foreign or retired renderers cannot change the current panel");
h.message({ type: "ready" });
assert.equal(first.webContents.messages[0].payload.value, "original");
h.ack();
assert.equal(c.panelDiagnostics().prepared, true);
assert.equal(first.visible, false, "preparation must never open a panel");
const preparedRevision = c.panelRenderRevision;
assert.equal(c.toggleTrayPanel(), "opened");
assert.equal(c.panelRenderRevision, preparedRevision, "an unchanged open must not rebuild the card");
assert.equal(first.webContents.messages.at(-1).channel, "companion:panel-present");
h.advance(12);
h.present();
assert.equal(first.visible, true, "prepared presentation shows without an arbitrary delay");
assert.equal(c.panelLastOpenLatencyMs, 12);
assert.equal(h.timers.size, 0, "showing a measured card must not schedule a fixed-delay timer");
h.message({ type: "frame", presentationID: c.panelPresentationID, renderRevision: c.panelRenderRevision, latencyMs: 18 });
assert.equal(c.panelLastFrameLatencyMs, 18);

assert.equal(c.toggleTrayPanel(), "closed");
assert.equal(first.destroyed, false);
assert.equal(first.visible, false);
assert.equal(c.panelAnchor, null);
assert.equal(h.timers.size, 0, "there is no fixed idle-destruction timer");
const unchangedMessages = first.webContents.messages.length;
c.sendPanelSnapshot();
assert.equal(first.webContents.messages.length, unchangedMessages, "unchanged hidden data does no work");
c.snapshot.value = "newest";
c.sendPanelSnapshot();
assert.equal(first.webContents.messages.at(-1).payload.value, "newest");
h.message({ type: "enter" });
h.ack();
assert.equal(c.hoverOpenTimer, null);
assert.equal(first.visible, false, "late resize replies cannot resurrect a closed panel");
assert.equal(c.windowContainsPoint(first, { x: 800, y: 30 }), false, "hidden cached windows cannot keep hover open");

const oldRevision = c.panelRenderRevision;
c.snapshot.value = "changed during click";
assert.equal(c.toggleTrayPanel(), "opened");
assert.equal(c.panelWindow, first);
assert.equal(c.panelReuseCount, 2);
assert.equal(first.webContents.messages.at(-1).payload.value, "changed during click");
h.ack(394, oldRevision);
h.present(c.panelPresentationID, oldRevision);
assert.equal(first.visible, false, "a warm reopen waits for the current snapshot, not an old cached frame");
h.ack(NaN);
h.ack(0);
assert.equal(first.visible, false);
h.ack();
h.present();
assert.equal(first.visible, true);
c.closePanel();
c.handleEnter();
assert.equal(c.hoverOpenTimer.ms, 80);
h.fire(c.hoverOpenTimer);
assert.equal(c.panelAnchor.type, "dot");
assert.equal(c.panelWindow, first, "desktop and tray entries share one recent renderer");
h.ack();
h.present();
assert(first.visible);
c.closePanel();
h.advance(10 * 60_000);
c.checkPreparedPanelMemoryBudget();
assert.equal(first.destroyed, false, "normal idle views remain prepared after ten minutes");
c.rendererMemoryKB = 193 * 1024;
c.checkPreparedPanelMemoryBudget();
assert(first.destroyed, "the existing resource check releases an over-budget hidden view");
assert.equal(c.panelMemoryReleaseCount, 1);
assert.equal(c.panelWindow, null);
assert.equal(c.panelRendererReady, false);

// Rapid close while the first page is loading must remain closed even when
// that renderer finishes startup. A later click can still reuse it safely.
c.openPanel({ type: "tray", point: { x: 800, y: 12 } });
const second = c.panelWindow;
c.closePanel();
h.message({ type: "ready" });
assert(second.webContents.messages.some((message) => message.channel === "companion:snapshot"));
h.ack();
h.present(c.panelPresentationID - 1);
assert.equal(second.visible, false);
c.openPanel({ type: "tray", point: { x: 800, y: 12 } });
h.ack();
h.present();
assert.equal(second.visible, true);
h.message({ type: "openTask", id: "one" });
assert.equal(c.openedTask, "one");
assert.equal(second.visible, false, "opening a task still dismisses the task card");

second.webContents.emit("render-process-gone");
assert(second.destroyed);
assert.equal(c.panelWindow, null);
assert.equal(h.windows.length, 2, "renderer failure must not cause an automatic restart loop");
c.toggleTrayPanel();
const third = c.panelWindow;
h.message({ type: "ready" }, second);
assert.equal(c.panelRendererReady, false);
h.message({ type: "ready" });
h.ack();
h.present();
assert(third.visible, "the next user open recovers from a failed renderer");
// A presentation reply from a just-closed open cannot revive it or complete
// the next request. Geometry/animation handoffs are request-scoped too.
const closedID = c.panelPresentationID;
c.closePanel();
h.present(closedID);
assert.equal(third.visible, false);
c.toggleTrayPanel();
h.present(closedID);
assert.equal(third.visible, false);
h.present();
assert.equal(third.visible, true);
c.snapshot.quota = { available: true, resetAt: 10_000 + 20 * 60_000 };
c.sendPanelSnapshot();
assert(c.panelClockTimer.ms > 0 && c.panelClockTimer.ms <= 60_020);
assert.equal(c.panelClockTimer.unreferenced, true);
c.closePanel();
c.quitting = true;
c.destroyPanel();
c.openPanel({ type: "tray" });
assert.equal(c.panelWindow, null);
assert.equal(h.timers.size, 0, "quit must release the cache and its one-shot timer");

const renderBlock = html.slice(html.indexOf("window.renderTaskPanel ="), html.indexOf('root.addEventListener("mouseenter"'));
assert.doesNotMatch(renderBlock, /requestAnimationFrame\(/, "hidden frames must not gate data preparation");
assert.doesNotMatch(html, /replaceChildren\(/, "updates must retain the existing card tree");
assert.match(html, /taskRows\.get\(task\.id\)/);
assert.match(html, /if \(layoutChanged\)/);
assert.match(html, /renderRevision: state\.renderRevision/);
assert.match(html, /root\.dataset\.renderRevision = String\(state\.renderRevision\)/);
assert.doesNotMatch(functionSource("openPanel", "createSettingsWindow"), /backgroundThrottling:\s*false|setInterval\(/);
assert.match(main, /taskPanel: panelDiagnostics\(\)/);
console.log("PASS panel-lifecycle (prewarm, incremental preparation, current revisions, late IPC, hover, memory budget, crash, quit)");

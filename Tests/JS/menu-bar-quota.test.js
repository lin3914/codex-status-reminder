"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {
  formatTrayQuotaTitle,
  syncTrayQuotaTitle
} = require("../../ElectronApp/tray-icon");

const now = Date.UTC(2026, 8, 30);
const resetAt = now + 7 * 24 * 3_600_000;
const available = {
  showMenuBarQuota: true,
  quotaAvailable: true,
  remainingPercent: 83,
  resetAt,
  now
};
for (const [remainingPercent, expected] of [
  [0, "0%"], [100, "100%"], [83, "83%"], [83.6, "84%"],
  [0.4, "0%"], [-1, "0%"], [101, "100%"]
]) {
  assert.equal(formatTrayQuotaTitle({ ...available, remainingPercent }), expected);
}
for (const remainingPercent of [null, undefined, NaN, Infinity, "83"]) {
  assert.equal(formatTrayQuotaTitle({ ...available, remainingPercent }), "—");
}
assert.equal(formatTrayQuotaTitle({ ...available, quotaAvailable: false }), "—");
assert.equal(formatTrayQuotaTitle({ ...available, resetAt: now }), "—");
assert.equal(formatTrayQuotaTitle({ ...available, resetAt: now - 1 }), "—");
assert.equal(formatTrayQuotaTitle({ ...available, showMenuBarQuota: false }), "");
assert.equal(formatTrayQuotaTitle({
  ...available, showMenuBarQuota: false, quotaAvailable: false
}), "");

function mockTray() {
  let title = "";
  return {
    updates: [],
    imageUpdates: [],
    isDestroyed: () => false,
    getTitle: () => title,
    setTitle(value, options) {
      title = value;
      this.updates.push({ value, options });
    },
    setToolTip(value) { this.tooltip = value; },
    setImage(image) { this.imageUpdates.push(image); }
  };
}
const tray = mockTray();
assert.equal(syncTrayQuotaTitle(tray, available), "83%");
assert.equal(tray.updates[0].options.fontType, "monospacedDigit");
syncTrayQuotaTitle(tray, available);
assert.equal(tray.updates.length, 1, "unchanged quota must not trigger native relayout");
syncTrayQuotaTitle(tray, { ...available, remainingPercent: 82 });
assert.equal(tray.getTitle(), "82%");
syncTrayQuotaTitle(tray, { ...available, showMenuBarQuota: false });
assert.equal(tray.getTitle(), "");
syncTrayQuotaTitle(tray, { ...available, quotaAvailable: false });
assert.equal(tray.getTitle(), "—");
syncTrayQuotaTitle(tray, available);
assert.equal(tray.getTitle(), "83%", "quota must recover after a missing-data state");

// Exercise the actual main-process binding, not a parallel copy of it.
const main = fs.readFileSync(path.join(__dirname, "../../ElectronApp/main.js"), "utf8");
const widgetContext = {
  settings: { showDesktopWidget: false },
  panelAnchor: { type: "tray" },
  dotWindow: { isDestroyed: () => false, destroy: () => { widgetContext.destroyed += 1; } },
  clearHoverOpenTimer: () => { widgetContext.clearedHover += 1; },
  closePanel: () => { widgetContext.closed += 1; },
  closed: 0, destroyed: 0, clearedHover: 0
};
vm.createContext(widgetContext);
const widgetStart = main.indexOf("function ensureDesktopWidget()");
const widgetEnd = main.indexOf("\nfunction createDotWindow()", widgetStart);
assert(widgetStart >= 0 && widgetEnd > widgetStart);
vm.runInContext(main.slice(widgetStart, widgetEnd), widgetContext);
widgetContext.ensureDesktopWidget();
assert.equal(widgetContext.closed, 0, "disabling / refreshing the desktop widget must preserve a tray-anchored task panel");
assert.equal(widgetContext.destroyed, 1);
assert.equal(widgetContext.clearedHover, 1);
widgetContext.panelAnchor = { type: "dot" };
widgetContext.ensureDesktopWidget();
assert.equal(widgetContext.closed, 1, "a desktop-anchored panel must close with its disabled widget");

const start = main.indexOf("function updateMenuBarAppearance()");
const end = main.indexOf("\nfunction refreshTrayMenu()", start);
assert(start >= 0 && end > start);
const context = {
  menuBarTray: mockTray(),
  menuBarTrayImage: null,
  menuBarTrayIconMode: null,
  menuBarLayoutTimer: null,
  quitting: false,
  setTimeout: (callback, delay) => {
    context.pendingLayout = callback;
    context.layoutDelay = delay;
    return { unref() {} };
  },
  clearTimeout: () => {},
  writeMenuBarRuntime: () => {},
  trayIcon: (mode) => ({ mode }),
  settings: { showMenuBarQuota: true },
  snapshot: {
    unreadCount: 58,
    runningCount: 4,
    quota: { available: true, remainingPercent: 83, resetAt: Date.now() + 86_400_000 }
  },
  panelAnchor: null,
  syncTrayQuotaTitle,
  copyFor: () => ({ appName: "CodeX状态提醒" }),
  trayAnchorPoint: () => ({ x: 500, y: 16 }),
  repositionPanel: () => { context.repositionCount += 1; },
  repositionCount: 0
};
vm.createContext(context);
vm.runInContext(main.slice(start, end), context);
context.updateMenuBarAppearance();
assert.equal(context.layoutDelay, 50);
context.pendingLayout();
assert.equal(context.menuBarTrayIconMode, "quota-star");
assert.equal(context.menuBarTrayImage.mode, "quota-star");
assert.equal(context.menuBarTray.imageUpdates.length, 1);
assert.equal(context.menuBarTray.getTitle(), "83%", "unread count must never replace weekly quota");
assert.equal(context.menuBarTray.tooltip, "CodeX状态提醒");
context.snapshot.unreadCount = 1;
context.snapshot.runningCount = 9;
context.updateMenuBarAppearance();
assert.equal(context.menuBarTray.updates.length, 1);
assert.equal(context.menuBarTray.imageUpdates.length, 1, "task updates must not reload or redraw unchanged artwork");
context.panelAnchor = { type: "tray", point: { x: 400, y: 16 } };
context.snapshot.quota.remainingPercent = 82;
context.updateMenuBarAppearance();
assert.equal(context.menuBarTray.getTitle(), "82%");
assert.equal(context.repositionCount, 0, "panel must wait for AppKit's updated frame");
context.pendingLayout();
assert.equal(context.panelAnchor.point.x, 500);
assert.equal(context.repositionCount, 1, "an open tray panel must follow a changed title width");
context.settings.showMenuBarQuota = false;
context.updateMenuBarAppearance();
assert.equal(context.menuBarTray.getTitle(), "");
assert.equal(context.menuBarTrayImage.mode, "full");
assert.equal(context.menuBarTrayIconMode, "full");
context.settings.showMenuBarQuota = true;
context.snapshot.quota.available = false;
context.updateMenuBarAppearance();
assert.equal(context.menuBarTray.getTitle(), "—");
assert.equal(context.menuBarTrayImage.mode, "quota-star", "missing quota keeps the compact brand marker");
assert.match(main, /trayTitle: menuBarTray\.getTitle\(\)/);

const trayModule = require("../../ElectronApp/tray-icon");
context.formatTrayQuotaLine = trayModule.formatTrayQuotaLine;
context.formatTrayTaskLine = trayModule.formatTrayTaskLine;
context.copyFor = () => ({
  appName: "CodeX状态提醒", settings: "打开设置…",
  showWidget: "展示桌面小组件", showMenuBarQuota: "菜单栏显示剩余周额度",
  completionNotifications: "任务完成提醒", openCodex: "打开 Codex", quit: "退出"
});
for (const [from, to] of [
  ["function menuBarStatePayload(", "\nfunction updateMenuBarAppearance("],
  ["function trayMenuTemplate(", "\nfunction horizontalIntersectionWidth("],
  ["function createMenuBarTray(", "\nfunction menuBarTrayIsHealthy("]
]) {
  const fromIndex = main.indexOf(from);
  const toIndex = main.indexOf(to, fromIndex);
  assert(fromIndex >= 0 && toIndex > fromIndex);
  vm.runInContext(main.slice(fromIndex, toIndex), context);
}
Object.assign(context, {
  effectiveLocale: () => "zh-CN",
  menuBarTray: null,
  menuBarTrayImage: null,
  menuBarTrayIconMode: null,
  menuBarCreateCount: 0,
  menuBarCreatedAt: 0,
  menuBarLeftEventCount: 0,
  menuBarLeftHandledCount: 0,
  menuBarLastLeftEventAt: 0,
  panelAnchor: null,
  trayIcon: (mode) => ({ mode }),
  writeMenuBarRuntime: () => {},
  scheduleMenuBarPlacementValidation: () => {},
  showSettings: () => {},
  openCodex: () => {},
  app: { quit() {} },
  Menu: { buildFromTemplate: (template) => template },
  toggleTrayPanel: () => {
    context.panelOpen = !context.panelOpen;
    return context.panelOpen ? "opened" : "closed";
  },
  closePanel: () => { context.panelOpen = false; },
  updateSettings: (patch) => {
    Object.assign(context.settings, patch);
    context.updateMenuBarAppearance();
  },
  Date: { now: () => context.testNow },
  testNow: 1000,
  Tray: class {
    constructor() {
      Object.assign(this, mockTray());
      this.handlers = {};
    }
    isDestroyed() { return false; }
    setIgnoreDoubleClickEvents() {}
    on(event, callback) { this.handlers[event] = callback; }
    popUpContextMenu(menu) { this.menu = menu; }
  }
});
context.settings.showMenuBarQuota = true;
context.snapshot.quota.available = true;
context.createMenuBarTray();
assert.equal(context.menuBarCreateCount, 1);
assert.equal(context.menuBarTrayImage.mode, "quota-star");
const menuHost = context.menuBarTray;
context.createMenuBarTray();
assert.equal(context.menuBarTray, menuHost, "refreshes must retain the single native tray host");
menuHost.handlers.click({}, { x: 500, y: 0, width: 70, height: 28 });
assert.equal(context.panelOpen, true);
context.testNow = 1400;
menuHost.handlers.click({}, { x: 500, y: 0, width: 70, height: 28 });
assert.equal(context.panelOpen, false);
assert.equal(context.menuBarLeftHandledCount, 2);
context.testNow = 1700;
menuHost.handlers["right-click"]();
assert.equal(context.menuBarLastRightClickAt, 1700);
assert(menuHost.menu.some((item) => item.label === "打开设置…"));
const quotaSwitch = menuHost.menu.find((item) => item.label === "菜单栏显示剩余周额度");
assert.equal(quotaSwitch.type, "checkbox");
assert.equal(quotaSwitch.checked, true);
quotaSwitch.click({ checked: false });
assert.equal(context.settings.showMenuBarQuota, false);
assert.equal(menuHost.getTitle(), "");
assert.equal(context.menuBarTrayImage.mode, "full");
quotaSwitch.click({ checked: true });
assert.equal(menuHost.getTitle(), "82%");
assert.equal(context.menuBarTrayImage.mode, "quota-star");
assert.equal(context.menuBarCreateCount, 1, "both shapes must reuse the existing menu-bar status item");
assert.equal(Object.hasOwn(menuHost.handlers, "mouse-enter"), false);

console.log("PASS menu-bar-quota");

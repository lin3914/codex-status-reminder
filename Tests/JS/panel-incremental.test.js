"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const html = fs.readFileSync(path.join(__dirname, "../../Resources/LegacyV11/panel.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
let measures = 0;
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.textContent = "";
    this.dataset = {};
    this.attributes = new Map();
    this.events = new Map();
    this.scrollTop = 0;
    const values = new Map();
    this.style = {
      setProperty: (key, value) => values.set(key, value),
      getPropertyValue: (key) => values.get(key)
    };
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, active) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        const include = active === undefined ? !names.has(name) : active;
        if (include) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
        return include;
      },
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false)
    };
  }
  append(...items) { for (const item of items) this.insertBefore(item, null); }
  insertBefore(item, before) {
    if (item === before) return;
    item.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert(index >= 0);
    this.children.splice(index, 0, item);
    item.parentElement = this;
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  addEventListener(type, callback) { this.events.set(type, callback); }
  querySelector(selector) {
    const name = selector.slice(1);
    for (const child of this.children) {
      if (child.classList.contains(name)) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  get clientHeight() { return parseFloat(this.style.getPropertyValue("--task-list-height")) || 0; }
  get scrollHeight() { return this.children.length * 82 + Math.max(0, this.children.length - 1) * 6; }
  getBoundingClientRect() { measures += 1; return { height: 394 }; }
}
const root = new Element("div");
const callbacks = new Map();
const messages = [];
const frames = new Map();
let nextFrame = 0;
const context = {
  document: {
    getElementById: () => root,
    createElement: (tag) => new Element(tag),
    documentElement: {},
    title: ""
  },
  window: {
    webkit: { messageHandlers: { panel: { postMessage: (message) => messages.push(message) } } },
    companion: Object.fromEntries(["Snapshot", "Position", "Present", "Visibility"].map(
      (name) => ["on" + name, (callback) => callbacks.set(name, callback)]
    ))
  },
  requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
  cancelAnimationFrame: (id) => frames.delete(id),
  Date
};
vm.createContext(context);
vm.runInContext(script, context);
const render = (state) => callbacks.get("Snapshot")(state);
const tasks = Array.from({ length: 6 }, (_, index) => ({
  id: "task-" + index, title: "Title " + index, progress: "Progress " + index,
  stateLabel: "待查看", stateClass: "unread"
}));
let state = {
  direction: "down", arrowX: 180, locale: "zh-CN", health: "healthy",
  healthLabel: "正常使用", healthDescription: "Within budget",
  quotaValue: "86%", timeValue: "93%", resetValue: "6天 12小时",
  unreadCount: 6, runningCount: 0, tasks, renderRevision: 1
};
render(state);
const frame = root.querySelector(".status-popover-frame");
const list = root.querySelector(".status-task-list");
const first = list.children[0];
assert.equal(measures, 1);
assert.equal(list.children.length, 6, "all retained tasks, not just visible rows, remain accessible");
assert.equal(list.clientHeight, 258);
assert.equal(frames.size, 0, "hidden preparation schedules no animation frames");
list.scrollTop = 150;
state = { ...state, quotaValue: "85%", renderRevision: 2,
  tasks: tasks.map((task, index) => index === 0 ? { ...task, progress: "Latest progress" } : task) };
render(state);
assert.equal(root.querySelector(".status-popover-frame"), frame);
assert.equal(list.children[0], first);
assert.equal(first.querySelector(".status-task-update-text").textContent, "Latest progress");
assert.equal(root.querySelector(".status-info-value").textContent, "85%");
assert.equal(list.scrollTop, 150);
assert.equal(measures, 1, "field-only updates do not measure or rebuild the layout");
assert.equal(messages.at(-1).type, "rendered");
state = { ...state, tasks: [...state.tasks].reverse(), renderRevision: 3 };
render(state);
assert.equal(list.children[5], first, "reordering preserves the same keyed task node");
assert.equal(list.scrollTop, 150);
assert.equal(measures, 1);
first.events.get("click")({ stopPropagation() {} });
assert.equal(messages.at(-1).id, "task-0");

callbacks.get("Present")({ presentationID: 10, renderRevision: 2, direction: "up", arrowX: 60 });
assert.notEqual(messages.at(-1).type, "presented", "obsolete content must not be acknowledged for presentation");
callbacks.get("Present")({ presentationID: 10, renderRevision: 3, direction: "up", arrowX: 60 });
assert(frame.classList.contains("is-up"));
assert.equal(messages.at(-1).type, "presented");
assert.equal(frames.size, 0, "presentation has no hidden-frame gate");
callbacks.get("Visibility")({ visible: true, presentationID: 10, requestedAt: Date.now() - 10 });
assert.equal(frames.size, 1, "only one visible-frame observation is scheduled");
callbacks.get("Visibility")({ visible: false });
assert.equal(frames.size, 0, "closing cancels the pending visible-frame observation");
assert(!frame.classList.contains("is-presenting"));

state = { ...state, tasks: [state.tasks[0]], unreadCount: 1, renderRevision: 4 };
render(state);
assert.equal(measures, 2, "row-count structural changes are measured");
assert.equal(list.scrollTop, 0, "shrinking the list clamps preserved scrolling");
state = { ...state, locale: "en", renderRevision: 5 };
render(state);
assert.equal(measures, 3, "language changes invalidate cached layout");
state = { ...state, tasks: [], unreadCount: 0, runningCount: 0, renderRevision: 6 };
render(state);
assert.equal(root.querySelector(".status-task-section"), null);
assert.equal(root.querySelector(".status-task-list"), null);
assert.equal(measures, 4);
state = { ...state, tasks: [{ ...tasks[0], title: "<img src=x onerror=alert(1)>" }], unreadCount: 1, renderRevision: 7 };
render(state);
assert.equal(root.querySelector(".status-task-title").textContent, state.tasks[0].title);
assert.equal(root.children.length, 1);
assert.equal(context.window.panelRendererDiagnostics().builds, 1);
assert.equal(frames.size, 0);
console.log("PASS panel-incremental (keyed nodes, current values, scrolling, no repeat layout, geometry, visible-only frames, empty and language states)");

"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createFrontmostApplicationMonitor } = require("../../ElectronApp/frontmost-app");

const children = [], changes = [], timers = new Map();
let id = 0;
const monitor = createFrontmostApplicationMonitor({
  resourcesPath: "/synthetic/resources", parentPID: 123,
  fsModule: { existsSync: () => true }, onChange: value => changes.push(value),
  setTimeoutFn(fn, ms) { const value = {id: ++id, unref() {}};
    timers.set(value.id, {fn, ms}); return value; },
  clearTimeoutFn(value) { timers.delete(value?.id); },
  spawn(command, args, options) {
    assert(command.endsWith("/Recovery/CodexCompanionRecovery"));
    assert.deepEqual(args, ["--observe-frontmost-app", "123"]);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
    const child = new EventEmitter(); child.stdout = new EventEmitter();
    child.stdout.setEncoding = value => assert.equal(value, "utf8");
    child.kill = () => { child.killed = true; }; child.unref = () => {};
    children.push(child); return child;
  }
});
const send = (child, identifier) => child.stdout.emit("data", JSON.stringify({bundleIdentifier: identifier}) + "\n");
const retry = () => {
  const next = [...timers].find(([,v]) => v.ms !== 3_000);
  assert(next, "a single backed-off reconnect should be scheduled");
  timers.delete(next[0]); next[1].fn(); return next[1].ms;
};
monitor.start(); monitor.start();
assert.equal(children.length, 1, "only one observer process");
assert.equal(monitor.getBundleIdentifier(), null);
send(children[0], null);
assert.deepEqual(changes, [null], "an initial unknown snapshot must be delivered");
children[0].stdout.emit("data", '{"bundleIdentifier":"com.openai.');
assert.equal(monitor.getBundleIdentifier(), null);
children[0].stdout.emit("data", 'codex"}\n');
assert.equal(monitor.getBundleIdentifier(), "com.openai.codex");
send(children[0], "com.openai.codex");
assert.equal(changes.length, 2, "identical snapshots are not extra activations");
send(children[0], "com.apple.finder");
assert.equal(monitor.getBundleIdentifier(), "com.apple.finder");
assert.equal(timers.size, 0, "a healthy observer has no polling or recurring timer");
children[0].emit("exit", 1);
assert(children[0].killed); assert.equal(changes.at(-1), null);
assert.equal(retry(), 1_000);
send(children[1], "com.apple.finder"); children[1].emit("exit", 1);
assert.equal(retry(), 2_000, "one good frame does not reset a short-lived crash budget");
send(children[0], "com.openai.codex");
assert.equal(monitor.getBundleIdentifier(), null, "late events from dead children are ignored");
children[2].stdout.emit("data", '{"bundleIdentifier":"not-a-bundle"}\n');
assert(children[2].killed); assert.equal(retry(), 4_000);
children[3].stdout.emit("data", "x".repeat(8_193));
assert(children[3].killed); assert.equal(retry(), 8_000);
monitor.stop();
assert(children.at(-1).killed); assert.equal(timers.size, 0);
children.at(-1).emit("exit", 0);
assert.equal(timers.size, 0, "stop cannot resurrect the observer");

const missing = createFrontmostApplicationMonitor({ resourcesPath: "/missing", fsModule: {existsSync: () => false},
  spawn() { throw new Error("missing helper must not spawn"); } });
missing.start(); assert.equal(missing.getBundleIdentifier(), null); missing.stop();
console.log("PASS frontmost-monitor: activation stream, framing, unknown state, no polling, stale events, bounded crash backoff and stop");

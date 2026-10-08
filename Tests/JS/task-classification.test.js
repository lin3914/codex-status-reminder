"use strict";

const assert = require("assert");
const path = require("path");
const {
  classifyTask,
  isTopLevelThread
} = require(path.join(__dirname, "..", "..", "ElectronApp", "task-classification"));

assert.equal(
  isTopLevelThread({
    thread_source: "subagent",
    source: "{\"subagent\":{\"thread_spawn\":{}}}"
  }),
  false,
  "subagent threads must not appear as user tasks"
);
assert.equal(
  isTopLevelThread({ thread_source: "user", source: "vscode" }),
  true,
  "top-level user threads must remain visible"
);
assert.equal(
  classifyTask({
    isUnread: false,
    hasOpenTurn: true,
    runtimeStatus: "notLoaded"
  }),
  "running",
  "a caller-validated fresh open turn must imply a running task"
);
assert.equal(
  classifyTask({
    isUnread: false,
    hasOpenTurn: false,
    runtimeStatus: "active"
  }),
  "running",
  "the live Codex active status must remain authoritative even outside the transcript tail"
);
assert.equal(
  classifyTask({
    isUnread: false,
    hasOpenTurn: false,
    runtimeStatus: "waiting_for_answer"
  }),
  "running",
  "waiting phases must remain visible as running until Codex reports a terminal state"
);
assert.equal(
  classifyTask({
    isUnread: true,
    hasOpenTurn: false,
    runtimeStatus: "idle"
  }),
  "unread",
  "Codex unread state must remain authoritative after completion"
);
assert.equal(
  classifyTask({
    isUnread: true,
    hasOpenTurn: true,
    runtimeStatus: "idle"
  }),
  "unread",
  "an explicit Codex idle state must move a stale open turn to 待查看"
);
assert.equal(
  classifyTask({
    isUnread: false,
    hasOpenTurn: true,
    runtimeStatus: "aborted"
  }),
  "completed",
  "a viewed aborted turn must be treated as 已处理 rather than 进行中"
);

assert.equal(classifyTask({isUnread: null, hasOpenTurn: false, runtimeStatus: "idle"}), "unknown",
  "a failed unread read must not be reported as a viewed/processed task");
assert.equal(classifyTask({isUnread: null, hasOpenTurn: true, runtimeStatus: "paused"}), "unknown");
assert.equal(classifyTask({isUnread: null, hasOpenTurn: false, runtimeStatus: "active"}), "running");
process.stdout.write("PASS task-classification\n");

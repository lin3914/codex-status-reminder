"use strict";
// Exercise the actual external worker under the packaged Electron Node
// runtime. The database, transcripts and read receipts are all synthetic.
module.exports = async function checkPackagedSpeedWorker({ base, isolatedData }) {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const { Worker } = require("node:worker_threads");
  const { speedPanel } = require(path.join(base, "token-speed.js"));
  const dir = path.join(isolatedData, "worker-fixture");
  fs.mkdirSync(dir);
  const globalStatePath = path.join(dir, ".codex-global-state.json");
  fs.writeFileSync(globalStatePath, JSON.stringify({ "electron-persisted-atom-state": {
    "unread-thread-ids-by-host-v1": { local: [] }
  } }));
  const now = Date.now(), startedAt = now - 20_000;
  const record = (at, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload });
  const transcript = path.join(dir, "fixture.jsonl");
  fs.writeFileSync(transcript, [record(startedAt, { type: "task_started" }),
    record(now - 5000, { type: "token_count", info: {
      total_token_usage: { output_tokens: 900 }, last_token_usage: { output_tokens: 900 }
    } }), ""].join("\n"));
  const db = new DatabaseSync(path.join(dir, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, name TEXT, preview TEXT, thread_source TEXT, source TEXT, cwd TEXT, agent_path TEXT);");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 0, 'Synthetic speed', '', 'cli', '', '', '')").run("synthetic-speed", transcript, now, now);
  db.close();
  const worker = new Worker(path.join(path.dirname(base), "Worker/task-data-worker.js"), {
    workerData: { codexHome: dir, globalStatePath }
  });
  let id = 0;
  const refresh = () => new Promise((resolve, reject) => {
    const requestID = ++id;
    const done = () => { clearTimeout(timer); worker.off("error", onError); worker.off("message", onMessage); };
    const onError = error => { done(); reject(error); };
    const onMessage = message => {
      if (message.id !== requestID) return;
      done();
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
    };
    const timer = setTimeout(() => { done(); reject(new Error("Packaged speed worker timed out")); }, 5000);
    worker.once("error", onError); worker.on("message", onMessage);
    worker.postMessage({ type: "refresh", id: requestID });
  });
  try {
    const running = await refresh();
    assert.equal(running.rows.length, 1);
    assert.equal(running.rows[0].observation.isRunning, true);
    const rate = speedPanel([{ state: "running", tokenSpeed: running.rows[0].observation.tokenSpeed }], "en", now);
    assert.equal(rate.rows[0].text, "30.0 tok/s");
    assert.equal(rate.total.text, "30.0 tok/s");
    fs.appendFileSync(transcript, record(now, { type: "task_complete", duration_ms: 20_000 }) + "\n");
    const ended = await refresh();
    assert.equal(ended.rows[0].observation.isRunning, false);
    const average = speedPanel([{ state: "completed", tokenSpeed: ended.rows[0].observation.tokenSpeed }], "en", now);
    assert.equal(average.rows[0].text, "45.0 tok/s");
    assert.equal(average.total.text, "0.0 tok/s");
  } finally {
    await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

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
  const refresh = (type = "refresh", threadIDs = []) => new Promise((resolve, reject) => {
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
    worker.postMessage({ type, threadIDs, id: requestID });
  });
  try {
    const running = await refresh();
    assert.equal(running.rows.length, 1);
    assert.equal(running.rows[0].observation.isRunning, true);
    const rate = speedPanel([{ state: "running", tokenSpeed: running.rows[0].observation.tokenSpeed }], "en", now);
    assert.equal(rate.rows[0].text, "30.0 tok/s");
    assert.equal(rate.total.text, "30.0 tok/s");
    const quiet = await refresh("check-active", ["synthetic-speed"]);
    assert.equal(quiet.changed, false);
    assert.equal(quiet.checkedPaths, 1);
    assert(!Object.hasOwn(quiet, "rows"), "quiet heartbeat does not copy historical tasks or samples over IPC");
    fs.appendFileSync(transcript, record(now - 1000, { type: "token_count", info: {
      total_token_usage: { output_tokens: 1200 }, last_token_usage: { output_tokens: 300 }
    } }) + "\n" + record(now - 1000, { type: "agent_message", message: "New hidden-panel progress" }) + "\n");
    assert.equal((await refresh("check-active", ["synthetic-speed"])).changed, true);
    const hidden = await refresh();
    assert.equal(hidden.rows[0].observation.latestProgress, "New hidden-panel progress");
    assert.equal(speedPanel([{ state: "running", tokenSpeed: hidden.rows[0].observation.tokenSpeed }], "en", now).total.text, "40.0 tok/s",
      "missed watch event is recovered before the first panel open");
    const delayed=speedPanel([{state:"running",tokenSpeed:hidden.rows[0].observation.tokenSpeed}],"en",now+60_000);
    assert.equal(delayed.rows[0].text,"40.0 tok/s");assert.equal(delayed.rows[0].label,"");
    assert.equal(delayed.total.text,"40.0 tok/s","worker serialization preserves enough bounded data to carry without new I/O");
    fs.appendFileSync(transcript, record(now, { type: "task_complete", duration_ms: 20_000 }) + "\n");
    const ended = await refresh();
    assert.equal(ended.rows[0].observation.isRunning, false);
    const average = speedPanel([{ state: "completed", tokenSpeed: ended.rows[0].observation.tokenSpeed }], "en", now);
    assert.equal(average.rows[0].text, "60.0 tok/s");
    assert.equal(average.total.text, "0.0 tok/s");
    const large = path.join(dir, "large-turn.jsonl");
    fs.writeFileSync(large, [
      record(now-120_000, {type:"token_count",info:{total_token_usage:{output_tokens:1000},last_token_usage:{output_tokens:1000}}}),
      record(now-100_000, {type:"task_started",turn_id:"large-turn"}),
      record(now-95_000, {type:"token_count",info:{total_token_usage:{output_tokens:1300},last_token_usage:{output_tokens:300}}}),
      JSON.stringify({type:"response_item",payload:{type:"function_call_output",output:"x".repeat(9*1024*1024)}}),
      record(now-85_000, {type:"token_count",info:{total_token_usage:{output_tokens:1600},last_token_usage:{output_tokens:300}}}),
      record(now-80_000, {type:"task_complete",turn_id:"large-turn",duration_ms:20_000}), ""
    ].join("\n"));
    const writer = new DatabaseSync(path.join(dir, "state_5.sqlite"));
    writer.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 0, 'Large turn', '', 'cli', '', '', '')").run("large-turn",large,now+1,now+1);
    writer.close();
    let recovered = await refresh(), largeSpeed = recovered.rows.find(row=>row.id==="large-turn").observation.tokenSpeed;
    assert.equal(recovered.speedBackfillPending,true);
    assert.equal(speedPanel([{state:"completed",tokenSpeed:largeSpeed}],"en",now).rows[0].value,null);
    let count=0;
    while(recovered.speedBackfillPending) {assert(++count<6);recovered=await refresh();}
    largeSpeed=recovered.rows.find(row=>row.id==="large-turn").observation.tokenSpeed;
    const recoveredPanel=speedPanel([{state:"completed",tokenSpeed:largeSpeed}],"en",now);
    assert.equal(recoveredPanel.rows[0].text,"30.0 tok/s","external packaged worker loads its new recovery module outside ASAR");
    assert.equal(recoveredPanel.total.text,"0.0 tok/s","recovered averages remain outside the active total");
  } finally {
    await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

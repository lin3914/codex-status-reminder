"use strict";

// Isolated, repeatable source-check cost measurement. Never opens real Codex
// data, creates UI, changes preferences, or modifies the installed app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const { TaskDataReader } = require("../ElectronApp/task-data-worker");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-profile-"));
let reader;
try {
  const now = Date.now(), globalStatePath = path.join(dir, ".codex-global-state.json");
  fs.writeFileSync(globalStatePath, JSON.stringify({ "electron-persisted-atom-state": {
    "unread-thread-ids-by-host-v1": { local: [] }
  } }));
  const db = new DatabaseSync(path.join(dir, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, name TEXT, preview TEXT, thread_source TEXT, source TEXT, cwd TEXT, agent_path TEXT)");
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 0, 'Synthetic', '', 'cli', '', '', '')");
  const record = (seconds, payload) => JSON.stringify({ timestamp: new Date(now + seconds * 1000).toISOString(), type: "event_msg", payload });
  const activeIDs = ["task-0", "task-1"];
  for (let i = 0; i < 102; i++) {
    const file = path.join(dir, i + ".jsonl");
    fs.writeFileSync(file, [record(-20, { type: "task_started" }),
      record(-10, { type: "token_count", info: { total_token_usage: { output_tokens: 900 }, last_token_usage: { output_tokens: 900 } } }),
      ...(i < 2 ? [] : [record(-5, { type: "task_complete", duration_ms: 15000 })]), ""].join("\n"));
    insert.run(`task-${i}`, file, now - i, now - i);
  }
  db.close();
  reader = new TaskDataReader({ codexHome: dir, globalStatePath });
  reader.refresh();
  for (let i = 0; i < 100; i++) reader.checkActive(activeIDs);
  const cacheSize = reader.transcripts.cache.size;
  const sampleCount = () => [...reader.transcripts.cache.values()].reduce((sum, value) => sum + value.observation.tokenSpeed.samples.length, 0);
  const samples = sampleCount();
  let queries = 0, contentReads = 0, transcriptBytes = 0;
  const prepare = reader.database.prepare.bind(reader.database);
  const read = fs.readFileSync, range = reader.transcripts.readRange.bind(reader.transcripts);
  reader.database.prepare = (...args) => { queries++; return prepare(...args); };
  fs.readFileSync = (...args) => { contentReads++; return read(...args); };
  reader.transcripts.readRange = (...args) => { const result = range(...args); transcriptBytes += result.length; return result; };
  global.gc?.();
  const beforeHeap = process.memoryUsage().heapUsed;
  const count = 10_000, cpuStart = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < count; i++) assert.equal(reader.checkActive(activeIDs).changed, false);
  const elapsed = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  global.gc?.();
  const afterHeap = process.memoryUsage().heapUsed;
  assert.equal(queries, 0); assert.equal(contentReads, 0); assert.equal(transcriptBytes, 0);
  assert.equal(reader.transcripts.cache.size, cacheSize); assert.equal(sampleCount(), samples);
  const quiet = { iterations: count, activePaths: activeIDs.length, elapsedMsPerCheck: elapsed / count,
    cpuMsPerCheck: (cpu.user + cpu.system) / 1000 / count,
    sqliteQueries: queries, contentReads, transcriptBytes,
    garbageCollected: Boolean(global.gc), heapDeltaBytesAfterGC: afterHeap - beforeHeap,
    transcriptCacheBefore: cacheSize, transcriptCacheAfter: reader.transcripts.cache.size,
    sampleCountBefore: samples, sampleCountAfter: sampleCount() };
  const fullStart = performance.now();
  for (let i = 0; i < 100; i++) reader.refresh();
  const report = { node: process.versions.node, electron: process.versions.electron || null,
    synthetic: true, totalTasks: 102, sourceCheckIntervalMs: 10_000, quiet,
    fullRefreshElapsedMsPerCheck: (performance.now() - fullStart) / 100,
    note: "In-process synthetic cost only, not a battery/power or whole-app CPU measurement." };
  console.log(JSON.stringify(report, null, 2));
} finally {
  reader?.close(); fs.rmSync(dir, { recursive: true, force: true });
}

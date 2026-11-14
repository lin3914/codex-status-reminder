"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { UsageIndex, usageEvent, DAY, WEEK } = require("../../ElectronApp/token-usage");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-"));
const at = Date.now();
const event = (stamp, total, last, sumOnly = false) => JSON.stringify({
  timestamp: new Date(stamp).toISOString(), type: "event_msg",
  payload: { type: "token_count", info: {
    total_token_usage: sumOnly ? { input_tokens: total - 10, output_tokens: 10, cached_input_tokens: 8, reasoning_output_tokens: 4 }
      : { total_tokens: total, cached_input_tokens: 8, reasoning_output_tokens: 4 },
    last_token_usage: { total_tokens: last }
  } }
}) + "\n";
const db = new DatabaseSync(":memory:");
try {
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,updated_at_ms INTEGER,archived INTEGER,thread_source TEXT,source TEXT,attached_thread_parent_id TEXT)");
  const columns = db.prepare("PRAGMA table_info(threads)").all().map(x => x.name);
  const insert = db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)");
  const a = path.join(dir, "a.jsonl"), b = path.join(dir, "b.jsonl"), child = path.join(dir, "child.jsonl");
  const huge = JSON.stringify({type:"response_item", payload:{body:"x".repeat(900_000)}}) + "\n";
  fs.writeFileSync(a, event(at - 8*DAY, 50, 50) + huge + event(at - WEEK, 100, 50)
    + event(at - 2*DAY, 180, 80) + event(at - DAY, 220, 40)
    + event(at - 60_000, 300, 80, true) + event(at - 55_000, 300, 80));
  fs.writeFileSync(b, event(at - 3_600_000, 100, 100));
  fs.writeFileSync(child, event(at - 60_000, 9000, 9000));
  insert.run("a", a, at, 0, "cli", "", null);
  insert.run("b", b, at, 1, "cli", "", null);
  insert.run("alias", b, at, 0, "cli", "", null);
  insert.run("child", child, at, 0, "cli", "", "a");
  const cache = path.join(dir, "usage-cache.json");
  const index = new UsageIndex(dir, cache);
  const ids = ["a", "b", "alias"];
  const run = (now = at, recheck = false, budget = 128*1024) => {
    let result, rounds = 0, bytes = 0;
    do {
      result = index.read(db, columns, ids, { now, recheck, budget });
      bytes += result.readBytes;
      assert(result.readBytes <= budget);
      recheck = false;
      assert(++rounds < 100);
    } while (result.pending);
    return { ...result, bytes, rounds };
  };
  const initial = index.read(db, columns, ids, { now: at, budget: 16 });
  assert.equal(initial.week.state, "loading");
  const fresh = run();
  assert(fresh.rounds > 1, "lifetime continues across bounded chunks, including a giant non-usage line");
  assert.deepEqual(fresh.week, { value: 300, state: "ready" });
  assert.deepEqual(fresh.day, { value: 180, state: "ready" });
  assert.deepEqual(fresh.sessions.a, { value: 300, state: "ready" });
  assert.deepEqual(fresh.sessions.b, { value: 100, state: "ready" });
  assert.deepEqual(fresh.sessions.alias, fresh.sessions.b);
  assert.equal(run(at, true).bytes, 0, "unchanged files are not reread");
  const warm = new UsageIndex(dir, cache).read(db, columns, ids, { now: at, recheck: true });
  assert.equal(warm.readBytes, 0, "verified offset cache makes an unchanged relaunch cold-read free");
  assert.deepEqual(warm.week, fresh.week);
  assert.deepEqual(warm.sessions.a, fresh.sessions.a);
  assert(!fs.readFileSync(cache, "utf8").includes(a), "the cache keeps numeric usage and fingerprints, not paths or dialogue");
  const append = event(at - 10_000, 350, 50);
  fs.appendFileSync(a, append.slice(0, -8));
  assert.equal(run(at, true).day.value, 180, "unfinished JSON is not counted");
  fs.appendFileSync(a, append.slice(-8));
  const updated = run(at, true);
  assert.equal(updated.bytes, 8, "only new bytes are read");
  assert.equal(updated.day.value, 230);
  assert.equal(updated.week.value, 350);
  assert.equal(updated.sessions.a.value, 350);
  const archived = path.join(dir, "archived-b.jsonl");
  fs.renameSync(b, archived);
  db.prepare("UPDATE threads SET rollout_path=? WHERE id IN ('b','alias')").run(archived);
  const moved = run(at + 60_001, true);
  assert.equal(moved.week.value, 350, "rename/alias is counted once");
  assert.equal(moved.bytes, 0, "same inode uses its existing ledger");
  const expired = run(at + DAY + 10);
  assert.equal(expired.day.value, 0);
  assert.equal(expired.week.value, 350);
  assert.equal(expired.bytes, 0, "rolling expiry does not reread the logs");
  fs.appendFileSync(a, event(at - 5000, 12, 12) + event(at - 3000, 24, 12));
  const reset = run(at + DAY + 20, true);
  assert.equal(reset.sessions.a.value, 362, "known post-reset increment, no reset point guess");
  assert.equal(reset.sessions.a.state, "partial");
  assert.equal(reset.week.state, "partial");
  fs.writeFileSync(a, event(at - 1000, 20, 20));
  const truncated = run(at + DAY + 60_040, true);
  assert.equal(truncated.sessions.a.value, 20);
  assert.equal(truncated.week.value, 120);
  fs.unlinkSync(archived);
  const missing = run(at + DAY + 120_100, true);
  assert.equal(missing.week.value, 20);
  assert.equal(missing.week.state, "partial");
  assert.deepEqual(missing.sessions.b, { value: null, state: "partial" });
  assert.equal(usageEvent(Buffer.from(event(at-100, 32, 32, true)), at).total, 32);
  console.log("PASS token-usage: exact windows and lifetime, incremental append, bounded slices, archive/alias, child scope, expiry, reset and deleted records");
} finally { db.close(); fs.rmSync(dir, {recursive: true, force: true}); }

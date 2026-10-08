"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  IncrementalTranscriptReader,
  TaskDataReader
} = require("../../ElectronApp/task-data-worker");

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-companion-task-worker-")
);

try {
  const transcriptPath = path.join(temporaryRoot, "rollout.jsonl");
  const started = [
    JSON.stringify({
      timestamp: "2026-08-17T09:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started" }
    }),
    JSON.stringify({
      timestamp: "2026-08-17T09:00:01.000Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "正在检查状态" }
    }),
    JSON.stringify({
      timestamp: "2026-08-17T09:00:01.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            secondary: {
              used_percent: 39,
              window_minutes: 10080,
              resets_at: 1787029200
            }
          }
        }
      }
    }),
    ""
  ].join("\n");
  fs.writeFileSync(transcriptPath, started);

  const incremental = new IncrementalTranscriptReader();
  const ranges = [];
  const originalReadRange = incremental.readRange.bind(incremental);
  incremental.readRange = (filePath, start, end) => {
    ranges.push({ start, end });
    return originalReadRange(filePath, start, end);
  };
  const first = incremental.read(transcriptPath);
  assert.equal(first.isRunning, true);
  assert.equal(first.latestProgress, "正在检查状态");
  assert.equal(first.latestRateLimits.secondary.used_percent, 39);

  const firstSize = fs.statSync(transcriptPath).size;
  fs.appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      timestamp: "2026-08-17T09:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "任务完成"
      }
    })}\n`
  );
  const second = incremental.read(transcriptPath);
  assert.equal(second.isRunning, false);
  assert.equal(second.latestProgress, "任务完成");
  assert.equal(
    ranges[1].start,
    firstSize,
    "subsequent reads must start at the previous byte offset"
  );

  const abortedTranscriptPath = path.join(
    temporaryRoot,
    "aborted-rollout.jsonl"
  );
  fs.writeFileSync(abortedTranscriptPath, [
    JSON.stringify({
      timestamp: "2026-08-17T09:05:00.000Z",
      type: "event_msg",
      payload: { type: "task_started" }
    }),
    JSON.stringify({
      timestamp: "2026-08-17T09:05:01.000Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "尚未结束的旧进展" }
    }),
    JSON.stringify({
      timestamp: "2026-08-17T09:05:02.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        reason: "interrupted",
        completed_at: 1786957502
      }
    }),
    // Codex can append final text after the interruption. It must not reopen
    // the turn without a new task_started / turn_context record.
    JSON.stringify({
      timestamp: "2026-08-17T09:05:04.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "已停止，等待下一步" }
    }),
    ""
  ].join("\n"));
  const aborted = incremental.read(abortedTranscriptPath);
  assert.equal(
    aborted.isRunning,
    false,
    "turn_aborted must close the running observation even when final text follows"
  );
  assert.equal(
    aborted.latestCompletedAt, 0,
    "an interrupted turn must not be presented as a successful completion"
  );
  assert.equal(
    aborted.latestTerminalAt,
    1786957502 * 1_000,
    "the terminal event timestamp must be retained for state reconciliation"
  );

  fs.appendFileSync(
    abortedTranscriptPath,
    `${JSON.stringify({
      timestamp: "2026-08-17T09:06:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-restarted-after-abort" }
    })}\n`
  );
  const restartedAfterAbort = incremental.read(abortedTranscriptPath);
  assert.equal(
    restartedAfterAbort.isRunning,
    true,
    "a new turn_context after interruption must restore the running state"
  );

  const compactedTranscriptPath = path.join(
    temporaryRoot,
    "compacted-rollout.jsonl"
  );
  fs.writeFileSync(compactedTranscriptPath, [
    JSON.stringify({
      timestamp: "2026-08-17T09:10:00.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-after-compaction" }
    }),
    JSON.stringify({
      timestamp: "2026-08-17T09:10:01.000Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "压缩后仍在执行" }
    }),
    ""
  ].join("\n"));
  const compacted = incremental.read(compactedTranscriptPath);
  assert.equal(
    compacted.isRunning,
    true,
    "a fresh turn_context must preserve running state after tail compaction"
  );

  const globalStatePath = path.join(temporaryRoot, ".codex-global-state.json");
  const threadID = "019fa123-4567-7890-abcd-123456789012";
  fs.writeFileSync(globalStatePath, JSON.stringify({
    "electron-persisted-atom-state": {
      "unread-thread-ids-by-host-v1": { local: [threadID] }
    }
  }));
  const databasePath = path.join(temporaryRoot, "state_5.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER,
      name TEXT,
      preview TEXT,
      archived INTEGER,
      thread_source TEXT,
      source TEXT,
      cwd TEXT,
      agent_path TEXT
    );
  `);
  database.prepare(`
    INSERT INTO threads (
      id, rollout_path, updated_at_ms, recency_at_ms, name, preview,
      archived, thread_source, source, cwd, agent_path
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'cli', '', '', '')
  `).run(
    threadID,
    transcriptPath,
    Date.now(),
    Date.now(),
    "资源效率测试",
    "测试预览"
  );
  database.close();

  const reader = new TaskDataReader({
    codexHome: temporaryRoot,
    globalStatePath
  });
  const snapshot = reader.refresh();
  assert.deepEqual(snapshot.unread.ids, [threadID]);
  assert.equal(snapshot.unread.available, true);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].observation.latestProgress, "任务完成");
  assert.equal(snapshot.rateLimits.secondary.used_percent, 39);
  assert.equal(
    snapshot.rateLimitsAt,
    Date.parse("2026-08-17T09:00:01.500Z")
  );
  assert.equal(snapshot.queryMode, "full");
  assert.equal(snapshot.changedRowCount, 1);

  const changedDatabase = new DatabaseSync(databasePath);
  changedDatabase.prepare(`
    UPDATE threads
       SET preview = ?,
           updated_at_ms = ?,
           recency_at_ms = ?
     WHERE id = ?
  `).run(
    "增量更新后的预览",
    Date.now() + 1_000,
    Date.now() + 1_000,
    threadID
  );
  changedDatabase.close();
  const incrementalSnapshot = reader.refresh();
  assert.equal(incrementalSnapshot.queryMode, "incremental");
  assert.equal(incrementalSnapshot.changedRowCount, 1);
  assert.equal(
    incrementalSnapshot.rows[0].preview,
    "增量更新后的预览"
  );

  // Exercise the real file reader and its refresh path against the new
  // account-and-host-scoped schema, not only the standalone JSON decoder.
  const { unreadIdentityKey, localUnreadHostKey } = require("../../ElectronApp/codex-state");
  const { classifyTask } = require("../../ElectronApp/task-classification");
  const auth = {
    auth_mode: "chatgpt",
    tokens: { access_token: `test.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account", user_id: "user" }
    })).toString("base64url")}.test` }
  };
  fs.writeFileSync(path.join(temporaryRoot, "auth.json"), JSON.stringify(auth));
  const scopedRoot = {
    "electron-thread-read-state-v1": {
      version: 1,
      unreadByIdentity: {
        [unreadIdentityKey(auth)]: { [localUnreadHostKey()]: [threadID] },
        "other-account": { [localUnreadHostKey()]: ["unrelated"] }
      },
      legacyMigration: { unreadThreadIdsByHostId: { local: ["stale"] } }
    }
  };
  fs.writeFileSync(globalStatePath, JSON.stringify(scopedRoot));
  const scopedSnapshot = reader.refresh();
  assert.deepEqual(scopedSnapshot.unread, { ids: [threadID], available: true });
  assert.equal(classifyTask({
    isUnread: scopedSnapshot.unread.ids.includes(threadID),
    hasOpenTurn: scopedSnapshot.rows[0].observation.isRunning,
    runtimeStatus: "idle"
  }), "unread");
  scopedRoot["electron-thread-read-state-v1"].unreadByIdentity[unreadIdentityKey(auth)][localUnreadHostKey()] = [];
  fs.writeFileSync(globalStatePath, JSON.stringify(scopedRoot));
  assert.deepEqual(reader.refresh().unread, { ids: [], available: true });
  fs.writeFileSync(path.join(temporaryRoot, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));
  assert.deepEqual(reader.refresh().unread, { ids: [], available: false }, "lost account context must not dismiss notifications");
  reader.close();
  console.log("PASS task-data-worker");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "ElectronApp/main.js"), "utf8");
const ipc = fs.readFileSync(
  path.join(root, "ElectronApp/codex-ipc-status.js"),
  "utf8"
);
const worker = fs.readFileSync(
  path.join(root, "ElectronApp/task-data-worker.js"),
  "utf8"
);
const quotaWorker = fs.readFileSync(
  path.join(root, "ElectronApp/quota-data-worker.js"),
  "utf8"
);
const appServerClient = fs.readFileSync(
  path.join(root, "ElectronApp/codex-app-server-client.js"),
  "utf8"
);

assert.doesNotMatch(
  main,
  /setInterval\([^)]*refreshTasks[^)]*,\s*2_000/,
  "task refresh must not return to a two-second full scan"
);
assert.match(
  main,
  /TASK_FALLBACK_REFRESH_MS = 60_000/,
  "event-driven task refresh must retain a low-frequency safety check"
);
assert.match(
  main,
  /QUOTA_REFRESH_MS = 5 \* 60_000/,
  "quota refresh must stay on the low-frequency five-minute schedule"
);
assert.match(
  quotaWorker,
  /account\/rateLimits\/updated/,
  "official quota changes must refresh through server notifications"
);
assert.match(
  quotaWorker,
  /UNSUPPORTED_RETRY_MS = 30 \* 60_000/,
  "unsupported Codex versions must not be relaunched in a tight loop"
);
assert.match(
  appServerClient,
  /if \(this\.startPromise\) return this\.startPromise/,
  "concurrent quota reads must share one app-server startup"
);
assert.match(
  main,
  /result\.rateLimits && !snapshot\.quota\.available/,
  "legacy transcript quota must never overwrite a live official snapshot"
);
assert.match(
  main,
  /fs\.watch\([\s\S]*?globalStatePath/,
  "the selected Codex state folder must drive task refresh"
);
assert.doesNotMatch(
  main,
  /setInterval\(\s*pollMenuBarCommand\s*,\s*250/,
  "the old 250 ms command-file polling loop must not return"
);
assert.doesNotMatch(
  main,
  /menuBarHelperHealthTimer|startMenuBarCommandTransport/,
  "the primary Tray implementation must not retain the helper health loop or command transport"
);
assert.match(
  main,
  /MENU_BAR_HEALTH_MS = 60_000/,
  "menu-bar recovery must use a low-frequency health check"
);
assert.doesNotMatch(
  main,
  /MENU_BAR_HEALTH_MS = (?:[1-9]\d{0,3}|[1-5]\d{4})\b/,
  "menu-bar recovery must not introduce frequent polling"
);
assert.match(
  main,
  /autoRecreateOnPlacementFailure: false/,
  "a live Tray must never be rebuilt merely because macOS has not placed it"
);
assert.doesNotMatch(
  main,
  /recoverMenuBarTrayPlacement|MENU_BAR_PLACEMENT_RECOVERY_LIMIT|MENU_BAR_BLOCKED_RETRY_MS/,
  "menu-bar placement must not create retry churn or duplicate hosts"
);
assert.match(
  main,
  /!hasTranscript[\s\S]*?runtimeCandidates\.push/,
  "IPC fallback must be limited to tasks without a readable transcript"
);
assert.match(
  ipc,
  /following:\s*false/,
  "temporary IPC follows must always have an explicit cancellation path"
);
assert.match(
  ipc,
  /MAX_CANDIDATES_PER_REFRESH = 24/,
  "IPC fallback must keep a hard candidate bound"
);
assert.match(
  ipc,
  /MAX_FRAME_BYTES = 32 \* 1024 \* 1024/,
  "IPC frames must retain a defensive size limit"
);
assert.doesNotMatch(
  ipc,
  /thread-stream-following-changed"[\s\S]{0,400}?this\.probe/,
  "Companion must never mirror another client's following request"
);
assert.match(
  worker,
  /new DatabaseSync\([^)]*[\s\S]*?readOnly:\s*true/,
  "task data must use a long-lived read-only SQLite connection"
);
assert.match(
  worker,
  /buildChangedThreadQuery/,
  "steady-state database refresh must be incremental"
);
assert.match(
  worker,
  /readRange\(filePath,\s*cached\.offset,\s*stats\.size\)/,
  "transcripts must be read from the last byte offset"
);
assert.match(
  main,
  /if \(previous && !previous\.isDestroyed\(\)\) previous\.destroy\(\)/,
  "disabling the desktop widget must release its renderer"
);
assert.match(
  main,
  /let completionBannerWindow = null/,
  "persistent completion cards must share one renderer host"
);
console.log("PASS resource-efficiency");

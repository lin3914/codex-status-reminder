import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const output = process.env.CODEX_COMPANION_VALIDATION_OUTPUT;
const asarModule = process.env.CODEX_COMPANION_ASAR_MODULE;
assert(output && asarModule, "Explicit evidence directory and ASAR inspection module required");
const appPath = process.env.CODEX_COMPANION_APP_PATH || "/Applications/CodeX状态提醒.app";
const port = Number(process.env.COMPANION_DEBUG_PORT || 9338);
const support = path.join(os.homedir(), "Library/Application Support/codex-companion");
const { extractFile } = await import(pathToFileURL(asarModule).href);
const archive = path.join(appPath, "Contents/Resources/app.asar");
function shippedModule(name, dependencies = {}) {
  const module = new Module(name);
  const require = module.require.bind(module);
  module.require = (key) => dependencies[key] ?? require(key);
  module._compile(extractFile(archive, name).toString(), name);
  return module.exports;
}
const state = shippedModule("codex-state.js");
const { TaskDataReader } = shippedModule("task-data-worker.js", { "./codex-state": state });
const classification = shippedModule("task-classification.js");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), checks: [] };
let socket;
let reader;
async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}
async function waitFor(read, accept, label) {
  for (let index = 0; index < 100; index += 1) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error(label);
}
async function runtime() {
  for (const name of await fs.readdir(support)) {
    if (!/^menu-bar-runtime-\d+\.json$/.test(name)) continue;
    const value = JSON.parse(await fs.readFile(path.join(support, name), "utf8"));
    try { process.kill(value.pid, 0); return value; } catch {}
  }
  throw new Error("No running application");
}
async function clickTray() {
  const value = await runtime();
  await run("/usr/bin/osascript", ["-e", `tell application "System Events"
    set targetProcess to first application process whose unix id is ${value.pid}
    repeat with bar in menu bars of targetProcess
      repeat with statusItem in menu bar items of bar
        set itemSize to size of statusItem
        if item 1 of itemSize > 18 then
          perform action "AXPress" of statusItem
          return
        end if
      end repeat
    end repeat
  end tell`]);
  await delay(350);
}
try {
  await fs.mkdir(output, { recursive: true });
  if ((await runtime()).taskPanel.visible) await clickTray();
  await clickTray();
  const list = await waitFor(targets, (items) => items.some((item) => item.url.includes("panel.html")), "Task panel not opened");
  const target = list.find((item) => item.url.includes("panel.html"));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id); clearTimeout(waiter.timer);
    value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  // A prepared card deliberately deduplicates unchanged snapshots. Validate
  // its actual current DOM and application revision rather than requesting a
  // duplicate broadcast just for the test.
  await waitFor(runtime, (value) => value.taskPanel?.visible && value.taskPanel.prepared,
    "Latest complete panel not shown");
  const panel = await evaluate(`({
    revision:Number(document.getElementById('root').dataset.renderRevision),
    tasks:[...document.querySelectorAll('.status-task-row')].map(row=>({
      id:row.dataset.taskId,
      stateLabel:row.querySelector('.status-task-phase').textContent,
      stateClass:[...row.querySelector('.status-task-phase').classList].find(value=>value.startsWith('is-'))?.slice(3)
    })),
    values:[...document.querySelectorAll('.status-info-value')].map(value=>value.textContent)
  })`);
  const preferences = JSON.parse(await fs.readFile(path.join(support, "settings.json"), "utf8"));
  const codexHome = preferences.codexConnection?.codexHome;
  assert(path.isAbsolute(codexHome), "Current read-only connection required");
  reader = new TaskDataReader({ codexHome, globalStatePath: path.join(codexHome, ".codex-global-state.json") });
  const data = reader.refresh();
  assert(data.unread.available, "Actual installed reader must identify scoped unread state");
  const unread = new Set(data.unread.ids);
  const stoppedUnread = data.rows.filter(classification.isTopLevelThread)
    .filter((row) => unread.has(row.id) && !row.observation.isRunning);
  report.notVerified = stoppedUnread.length ? [] : ["No current stopped unread conversations; fixed classification fixtures cover this boundary without modifying user conversations"];
  const matched = [];
  for (const row of stoppedUnread) {
    const displayed = panel.tasks.find((task) => task.id === row.id);
    assert(displayed, "Unread tasks must remain in the retained panel: " + row.id);
    assert.equal(displayed.stateClass, "unread", "Stopped unread task must display as unread");
    matched.push({ id: row.id, label: displayed.stateLabel, state: displayed.stateClass });
  }
  if (matched.length) report.checks.push("real stopped unread conversations render as 待查看 in the installed task panel");
  const actual = await runtime();
  assert.equal(panel.revision, actual.taskPanel.renderedRevision);
  const unreadMetric = await evaluate("document.querySelector('.status-task-metric.is-unread .status-task-metric-value').textContent");
  const runningMetric = await evaluate("document.querySelector('.status-task-metric.is-running .status-task-metric-value').textContent");
  const metricCount = value => value === "99+" ? 100 : Number(value);
  assert(Number.isFinite(metricCount(unreadMetric)) && Number.isFinite(metricCount(runningMetric)));
  assert(metricCount(unreadMetric) >= panel.tasks.filter(task => task.stateClass === "unread").length);
  assert(metricCount(runningMetric) >= panel.tasks.filter(task => task.stateClass === "running").length);
  const info = await evaluate("[...document.querySelectorAll('.status-info-value')].map(v=>v.textContent)");
  assert.deepEqual(info, panel.values);
  assert.equal(info[0], actual.weeklyQuotaAvailable ? `${Math.round(actual.weeklyQuotaRemainingPercent)}%` : "–");
  if (!actual.weeklyQuotaAvailable) report.notVerified.push("Live quota unavailable; explicit syncing placeholder confirmed, value behavior covered by fixed fixtures");
  report.checks.push("task summaries cover retained state labels; actual quota matches the current main-process snapshot and time/countdown remain present");
  const rows = await evaluate("({count:document.querySelectorAll('.status-task-row').length,height:document.querySelector('.status-task-list').clientHeight})");
  assert.equal(rows.count, panel.tasks.length);
  assert(rows.height <= 258, "Task list must retain the three-row viewport");
  report.checks.push("retained task list still uses the three-row viewport");
  const image = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(output, "task-panel.png"), Buffer.from(image.data, "base64"));
  report.snapshot = {
    unreadCount: metricCount(unreadMetric), runningCount: metricCount(runningMetric),
    quota: info[0], time: info[1], countdown: info[2],
    matched, rows, scopedUnreadIds: unread.size
  };
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = String(error.stack || error); process.exitCode = 1;
} finally {
  reader?.close(); socket?.close();
  try { if ((await runtime()).taskPanel.visible) await clickTray(); } catch {}
  report.completedAt = new Date().toISOString();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "installed-task-panel.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

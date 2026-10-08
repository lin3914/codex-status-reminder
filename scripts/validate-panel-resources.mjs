import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const output = process.argv[2], name = process.argv[3] || "after";
const seconds = Number(process.argv[4] || 60);
assert(output && path.isAbsolute(output), "An absolute evidence directory is required");
assert(Number.isFinite(seconds) && seconds >= 60 && seconds <= 900);
const support = path.join(os.homedir(), "Library/Application Support/codex-companion");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runtime() {
  for (const file of await fs.readdir(support)) {
    if (!/^menu-bar-runtime-\d+\.json$/.test(file)) continue;
    try {
      const state = JSON.parse(await fs.readFile(path.join(support, file), "utf8"));
      process.kill(state.pid, 0);
      if (state.bundleIdentifier === "com.lindaozhi.codexstatusreminder") return state;
    } catch {}
  }
  throw new Error("App is not running");
}
function cpuSeconds(value) {
  const [clock, days] = value.includes("-") ? [value.split("-")[1], Number(value.split("-")[0])] : [value, 0];
  const fields = clock.split(":").map(Number);
  return days * 86400 + fields.reduce((total, item) => total * 60 + item, 0);
}
async function sample(pid) {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,comm="]);
  const all = stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKB: Number(match[3]), cpuSeconds: cpuSeconds(match[4]), name: path.basename(match[5]) }] : [];
  });
  const owned = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of all) if (owned.has(item.ppid) && !owned.has(item.pid)) { owned.add(item.pid); changed = true; }
  }
  const processes = all.filter((item) => owned.has(item.pid));
  assert(processes.some((item) => item.pid === pid), "Main process exited");
  return { at: Date.now(), rssKB: processes.reduce((sum, item) => sum + item.rssKB, 0), processes };
}
await fs.mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), requestedSeconds: seconds, measurement: "Process-tree resident memory (RSS) and CPU-time deltas; 100% CPU means one fully occupied core. Not a power/energy measurement.", samples: [] };
try {
  const state = await runtime();
  report.pid = state.pid;
  report.initialPanel = state.taskPanel;
  assert.equal(state.taskPanel.visible, false, "Resource comparison requires a hidden card");
  const port = Number(process.env.COMPANION_DEBUG_PORT || 9338);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  report.openPages = targets.filter((item) => item.type === "page").map((item) => path.basename(item.url));
  const start = await sample(state.pid);
  report.samples.push(start);
  while (Date.now() - start.at < seconds * 1000) {
    await delay(Math.min(10000, seconds * 1000 - (Date.now() - start.at)));
    const current = await sample(state.pid), previous = report.samples.at(-1);
    const prior = new Map(previous.processes.map((item) => [item.pid, item]));
    current.cpuDeltaSeconds = current.processes.reduce((sum, item) => sum + (prior.has(item.pid) ? Math.max(0, item.cpuSeconds - prior.get(item.pid).cpuSeconds) : 0), 0);
    current.cpuPercent = current.cpuDeltaSeconds / ((current.at - previous.at) / 1000) * 100;
    current.processSetChanged = current.processes.length !== prior.size || current.processes.some((item) => !prior.has(item.pid));
    report.samples.push(current);
    console.log(JSON.stringify({scenario:name,elapsedSeconds:Math.round((current.at-start.at)/1000),rssMiB:Math.round(current.rssKB/1024),cpuPercent:Math.round(current.cpuPercent*100)/100,processes:current.processes.length}));
  }
  const end = report.samples.at(-1);
  const cpuDelta = report.samples.slice(1).reduce((sum, item) => sum + item.cpuDeltaSeconds, 0);
  report.summary = {
    elapsedSeconds: (end.at - start.at) / 1000,
    averageCPUPercent: cpuDelta / ((end.at - start.at) / 1000) * 100,
    peakIntervalCPUPercent: Math.max(...report.samples.slice(1).map((item) => item.cpuPercent)),
    averageRSSMiB: report.samples.reduce((sum, item) => sum + item.rssKB / 1024, 0) / report.samples.length,
    peakRSSMiB: Math.max(...report.samples.map((item) => item.rssKB / 1024)),
    processSetStable: report.samples.slice(1).every((item) => !item.processSetChanged)
  };
  const final = await runtime();
  assert.equal(final.pid, state.pid);
  assert.equal(final.taskPanel.visible, false, "Card must remain hidden during resource sampling");
  report.finalPanel = final.taskPanel;
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error.stack || error); process.exitCode = 1; }
await fs.writeFile(path.join(output, `${name}-resources.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({passed:report.passed,summary:report.summary,error:report.error}, null, 2));

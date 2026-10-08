import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatTrayQuotaTitle } from "../ElectronApp/tray-icon.js";

const run = promisify(execFile);
const support = path.join(os.homedir(), "Library/Application Support/codex-companion");
const output = process.env.CODEX_COMPANION_VALIDATION_OUTPUT;
assert(output, "Explicit evidence output directory is required");
const interval = 20_000;
const samples = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function currentRuntime() {
  for (const name of await fs.readdir(support)) {
    if (!/^menu-bar-runtime-\d+\.json$/.test(name)) continue;
    try {
      const state = JSON.parse(await fs.readFile(path.join(support, name), "utf8"));
      process.kill(state.pid, 0);
      return state;
    } catch {}
  }
  throw new Error("No running native tray host found");
}
function cpuSeconds(value) {
  const parts = value.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}
async function sample() {
  const state = await currentRuntime();
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,command="]);
  const ownProcesses = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match?.[5].startsWith("/Applications/CodeX状态提醒.app/Contents/")) return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]), rssKB: Number(match[3]), cpuSeconds: cpuSeconds(match[4]) }];
  });
  const diagnostics = JSON.parse(await fs.readFile(path.join(support, "resource-diagnostics.json"), "utf8"));
  assert(state.trayBoundsInMenuBar && state.trayCreateCount === 1 && !state.trayDestroyed);
  assert.equal(state.trayTitle, formatTrayQuotaTitle({
    showMenuBarQuota: state.showMenuBarQuota, quotaAvailable: state.weeklyQuotaAvailable,
    remainingPercent: state.weeklyQuotaRemainingPercent, resetAt: state.weeklyQuotaResetAt
  }));
  return {
    at: Date.now(), pid: state.pid, title: state.trayTitle,
    lastError: state.lastError, visible: state.trayBoundsInMenuBar,
    createCount: state.trayCreateCount, recoveryCount: state.trayRecoveryCount,
    ownProcesses, totalRSSKB: ownProcesses.reduce((sum, p) => sum + p.rssKB, 0),
    taskRefreshMs: diagnostics.taskRefresh.durationMs,
    quotaSource: diagnostics.quotaRefresh.source,
    quotaIntervalMs: diagnostics.quotaRefresh.intervalMs
  };
}
try {
  for (let index = 0; index < 7; index += 1) {
    if (index) await delay(interval);
    samples.push(await sample());
    assert.equal(samples.at(-1).pid, samples[0].pid, "Main application restarted unexpectedly");
    console.log(`PASS steady sample ${index + 1}/7 title=${samples.at(-1).title} pid=${samples.at(-1).pid}`);
  }
  const elapsedSeconds = (samples.at(-1).at - samples[0].at) / 1_000;
  const initial = new Map(samples[0].ownProcesses.map((p) => [p.pid, p.cpuSeconds]));
  const cpuDelta = samples.at(-1).ownProcesses.reduce((total, p) => total + Math.max(0, p.cpuSeconds - (initial.get(p.pid) ?? p.cpuSeconds)), 0);
  const result = {
    passed: true, completedAt: new Date().toISOString(), elapsedSeconds,
    combinedCPUPercentOneCore: cpuDelta / elapsedSeconds * 100,
    rssStartMB: samples[0].totalRSSKB / 1024,
    rssEndMB: samples.at(-1).totalRSSKB / 1024,
    notes: "Bounded 120-second observation on this Mac, not a memory-leak or long-term energy benchmark. CPU uses cumulative ps time differences for surviving bundled processes; RSS is summed per-process resident memory, not unique physical footprint. Codex itself and other applications are excluded.",
    samples
  };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "steady-state.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, elapsedSeconds, combinedCPUPercentOneCore: result.combinedCPUPercentOneCore, rssStartMB: result.rssStartMB, rssEndMB: result.rssEndMB }));
} catch (error) {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "steady-state.json"), JSON.stringify({ passed: false, error: String(error.stack || error), samples }, null, 2));
  throw error;
}

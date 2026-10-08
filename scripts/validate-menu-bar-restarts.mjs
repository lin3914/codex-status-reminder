#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatTrayQuotaTitle } from "../ElectronApp/tray-icon.js";

const run = promisify(execFile);
const appPath = process.argv[2] || "/Applications/CodeX状态提醒.app";
const iterations = Number(process.argv[3] || process.env.COMPANION_RESTART_ITERATIONS || 10);
const expectedMenuBarQuota = process.env.COMPANION_EXPECT_MENU_BAR_QUOTA === undefined
  ? null
  : process.env.COMPANION_EXPECT_MENU_BAR_QUOTA === "1";
const bundleIdentifier = "com.lindaozhi.codexstatusreminder";
const menuBarIdentityMode = "bundle-default-slot-v7";
const displayEdgeEpsilon = 2;
const appExecutablePath = path.join(appPath, "Contents", "MacOS", "Codex Companion");
const appExecutablePattern = `^${appExecutablePath.replace(
  /[.*+?^${}()|[\]\\]/g,
  "\\$&",
)}( |$)`;
const runtimeDirectory = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "codex-companion",
);
const reportPath = process.env.CODEX_COMPANION_RESTART_REPORT || path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "menu-bar-restart-validation.json",
);

const delay = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runtimeFiles() {
  try {
    return (await fs.readdir(runtimeDirectory))
      .filter((name) => /^menu-bar-runtime-\d+\.json$/.test(name))
      .map((name) => path.join(runtimeDirectory, name));
  } catch {
    return [];
  }
}

async function removeStaleRuntimeFiles() {
  await Promise.all((await runtimeFiles()).map(
    (file) => fs.rm(file, { force: true }),
  ));
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runningMainProcessIDs() {
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-f", appExecutablePattern]);
    return stdout.split("\n")
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger);
  } catch (error) {
    // pgrep returns 1 when no process matches, which is the normal stopped
    // state between restart iterations.
    if (error?.code === 1) return [];
    throw error;
  }
}

async function waitForMainProcessStart(timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const processIDs = await runningMainProcessIDs();
    if (processIDs.length > 0) return processIDs;
    await delay(100);
  }
  return [];
}

async function readRuntime(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function waitForHealthyRuntime(startedAt, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastCandidate = null;
  let healthySince = null;
  let healthyPID = null;
  while (Date.now() < deadline) {
    let foundHealthy = false;
    for (const file of await runtimeFiles()) {
      const state = await readRuntime(file);
      if (
        state
        && state.updatedAt >= startedAt
        && await processExists(state.pid)
        && state.bundleIdentifier === bundleIdentifier
      ) {
        lastCandidate = state;
        const healthy = (
          state.menuBarImplementation === "electron-main-tray"
          && state.menuBarIdentityMode === menuBarIdentityMode
        && state.guid === null
        && state.traySlot === "default-0"
        && state.autoRecreateOnPlacementFailure === false
          && state.trayDestroyed === false
          && state.imageEmpty === false
          && state.imageTemplate === true
          && state.trayBoundsInMenuBar === true
          && state.trayPlacementState === "visible"
          && state.trayTouchesDisplayRightEdge === false
          && state.layoutPending === false
          && state.trayRightEdgeGap > displayEdgeEpsilon
          && state.trayDisplay
          && state.iconMode === (state.showMenuBarQuota ? "quota-star" : "full")
          && state.imageLogicalSize?.width === (state.showMenuBarQuota ? 9 : 22)
          && state.imageLogicalSize?.height === 22
        );
        if (healthy) {
          foundHealthy = true;
          if (healthyPID !== state.pid) {
            healthyPID = state.pid;
            healthySince = Date.now();
          }
          // Require a continuous placement instead of accepting a transient
          // state while Control Center attaches the one standard Tray host.
          if (Date.now() - healthySince >= 3_000) return { file, state };
        }
      }
    }
    if (!foundHealthy) {
      healthySince = null;
      healthyPID = null;
    }
    await delay(100);
  }
  throw new Error(
    `healthy menu-bar runtime did not remain visible for 3 seconds within 20 seconds; last=${JSON.stringify(lastCandidate)}`,
  );
}

async function controlCenterHostState(pid, startedAt) {
  let stdout = "";
  try {
    ({ stdout } = await run(
      "/usr/bin/log",
      [
        "show",
        "--start",
        `@${Math.floor((startedAt - 250) / 1_000)}`,
        "--style",
        "compact",
        "--predicate",
        `process == "ControlCenter" AND eventMessage CONTAINS "${bundleIdentifier}"`,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch {
    return { visible: null, evidence: [] };
  }
  const hostSuffix = `-${pid})`;
  const evidence = stdout.split("\n").filter(
    (line) => (
      line.includes("com.apple.controlcenter:appStatusItems")
      && line.includes(bundleIdentifier)
      && (
        line.includes(hostSuffix)
        || line.includes(hostSuffix)
      )
    ),
  );
  let visible = null;
  for (const line of evidence) {
    if (
      line.includes("Moving host to blocked list")
      || line.includes("Starting to track blocked host")
    ) {
      visible = false;
    } else if (
      line.includes("Unblocking host")
      || line.includes("Starting to track host")
    ) {
      visible = true;
    }
  }
  return { visible, evidence: evidence.slice(-12) };
}

async function readControlCenterLifecycle(
  pid,
  startedAt,
  timeoutMilliseconds = 4_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let last = { visible: null, evidence: [] };
  while (Date.now() < deadline) {
    last = await controlCenterHostState(pid, startedAt);
    await delay(250);
  }
  return last;
}

async function accessibilityMenuBarItem(pid, displayBounds) {
  const script = [
    'tell application "System Events"',
    `set targetProcess to first application process whose unix id is ${pid}`,
    'set matchingItems to ""',
    "repeat with menuBarElement in menu bars of targetProcess",
    "repeat with statusElement in menu bar items of menuBarElement",
    "try",
    "set itemPosition to position of statusElement",
    "set itemSize to size of statusElement",
    "set itemX to item 1 of itemPosition",
    "set itemY to item 2 of itemPosition",
    "set itemWidth to item 1 of itemSize",
    "set itemHeight to item 2 of itemSize",
    "if itemX ≥ 0 and itemY ≥ -2 and itemY < 50 and itemWidth ≥ 18 and itemHeight ≥ 18 then",
    'set matchingItems to matchingItems & (itemX as text) & "|" & (itemY as text) & "|" & (itemWidth as text) & "|" & (itemHeight as text) & ";"',
    "end if",
    "end try",
    "end repeat",
    "end repeat",
    "return matchingItems",
    "end tell",
  ];
  try {
    const { stdout } = await run(
      "/usr/bin/osascript",
      script.flatMap((line) => ["-e", line]),
    );
    const candidates = stdout.trim().split(";").filter(Boolean).map((item) => {
      const [x, y, width, height] = item.split("|").map(Number);
      return { x, y, width, height };
    }).filter(
      ({ x, y, width, height }) => (
        [x, y, width, height].every(Number.isFinite)
      ),
    );
    const displayRightEdge = displayBounds.x + displayBounds.width;
    const visible = candidates.find(({ x, y, width, height }) => (
      x >= displayBounds.x
      && y >= displayBounds.y - 2
      && x + width <= displayRightEdge
      && Math.abs(displayRightEdge - x - width) > displayEdgeEpsilon
      && y + height <= displayBounds.y + 72
    ));
    return {
      visible: Boolean(visible),
      bounds: visible || null,
      candidates,
      hiddenAtDisplayEdge: candidates.some(
        ({ x, width }) => (
          Math.abs(displayRightEdge - x - width) <= displayEdgeEpsilon
        ),
      ),
    };
  } catch (error) {
    return {
      visible: null,
      bounds: null,
      error: String(error?.stderr || error?.message || error),
    };
  }
}

async function waitForAccessibilityMenuBarItem(
  pid,
  displayBounds,
  timeoutMilliseconds = 5_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let last = null;
  while (Date.now() < deadline) {
    last = await accessibilityMenuBarItem(pid, displayBounds);
    if (last.visible === true) return last;
    await delay(250);
  }
  throw new Error(
    `macOS Accessibility did not expose a visible Codex Companion status item for ${pid}: ${JSON.stringify(last)}`,
  );
}

async function quitApp(timeoutMilliseconds = 10_000) {
  try {
    await run("/usr/bin/osascript", [
      "-e",
      `tell application id "${bundleIdentifier}" to quit`,
    ]);
  } catch {
    // A missing process is already the desired state.
  }
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const mainProcessIDs = await runningMainProcessIDs();
    const states = await Promise.all((await runtimeFiles()).map(readRuntime));
    const active = (
      await Promise.all(
        states.filter(Boolean).map((state) => processExists(state.pid)),
      )
    ).some(Boolean);
    // The old implementation considered the app stopped once its runtime JSON
    // was gone. Electron can remove that file before the main process fully
    // exits; Finder then accepts a second open request while macOS still sees
    // the first instance, and no new launch occurs. Wait for both layers.
    if (!active && mainProcessIDs.length === 0) return;
    await delay(100);
  }
  throw new Error("Codex Companion did not quit gracefully within 10 seconds");
}

async function openApp() {
  let lastError = null;
  const escapedAppPath = appPath
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // Tahoe attributes a status item to the application responsible for
      // launching it. Starting a production bundle directly from a terminal
      // or coding agent can poison Control Center's allow-list. Route the
      // restart gate through Finder, matching a real installation launch.
      await run("/usr/bin/osascript", [
        "-e",
        `tell application "Finder" to open (POSIX file "${escapedAppPath}" as alias)`,
      ]);
      const processIDs = await waitForMainProcessStart();
      if (processIDs.length > 0) return;
      lastError = new Error("Finder accepted the launch request but no main process appeared");
    } catch (error) {
      lastError = error;
    }
    await delay(500 * (attempt + 1));
  }
  throw lastError;
}

assert(Number.isInteger(iterations) && iterations >= 2, "iterations must be an integer >= 2");
await fs.access(path.join(appPath, "Contents", "Info.plist"));
await quitApp();

const results = [];
for (let index = 0; index < iterations; index += 1) {
  await removeStaleRuntimeFiles();
  const startedAt = Date.now();
  await openApp();
  const { state } = await waitForHealthyRuntime(startedAt);
  const savedSettings = JSON.parse(await fs.readFile(
    path.join(runtimeDirectory, "settings.json"), "utf8",
  ));
  assert(
    expectedMenuBarQuota === null || savedSettings.showMenuBarQuota === expectedMenuBarQuota,
    "menu-bar quota preference did not match the requested restart test scenario",
  );
  assert(
    state.showMenuBarQuota === savedSettings.showMenuBarQuota,
    "menu-bar quota preference did not survive the restart",
  );
  assert(
    state.trayTitle === formatTrayQuotaTitle({
      showMenuBarQuota: savedSettings.showMenuBarQuota,
      quotaAvailable: state.weeklyQuotaAvailable,
      remainingPercent: state.weeklyQuotaRemainingPercent,
      resetAt: state.weeklyQuotaResetAt,
    }),
    "menu-bar quota title did not match the restored weekly quota",
  );
  const accessibility = await waitForAccessibilityMenuBarItem(
    state.pid,
    state.trayDisplay.bounds,
  );
  const controlCenter = await readControlCenterLifecycle(
    state.pid,
    startedAt,
  );
  assert(
    controlCenter.visible !== false,
    `Control Center reported a blocked status item: ${JSON.stringify(controlCenter)}`,
  );
  assert(
    accessibility.visible === true
      && accessibility.hiddenAtDisplayEdge === false,
    `Accessibility exposed only a hidden edge placeholder: ${JSON.stringify(accessibility)}`,
  );
  assert(
    state.trayCreateCount === 1 && state.trayRecoveryCount === 0,
    `one app launch must create exactly one Tray host: ${JSON.stringify(state)}`,
  );
  results.push({
    iteration: index + 1,
    pid: state.pid,
    identityMode: state.menuBarIdentityMode,
    showMenuBarQuota: state.showMenuBarQuota,
    trayTitle: state.trayTitle,
    weeklyQuotaRemainingPercent: state.weeklyQuotaRemainingPercent,
    guid: state.guid,
    bounds: state.trayBounds,
    display: state.trayDisplay,
    visible: state.trayBoundsInMenuBar,
    imageLogicalSize: state.imageLogicalSize,
    imageScaleFactors: state.imageScaleFactors,
    createCount: state.trayCreateCount,
    recoveryCount: state.trayRecoveryCount,
    healthReason: state.lastHealthReason,
    controlCenterLogState: controlCenter.visible,
    controlCenterVisible: controlCenter.visible,
    controlCenterDiagnosticsAvailable: controlCenter.visible !== null,
    controlCenterEvidence: controlCenter.evidence,
    accessibilityVisible: accessibility.visible,
    accessibilityBounds: accessibility.bounds,
    accessibilityCandidates: accessibility.candidates,
    accessibilityHiddenAtDisplayEdge: accessibility.hiddenAtDisplayEdge,
  });
  console.log(`PASS restart ${index + 1}/${iterations} quotaTitle=${JSON.stringify(state.trayTitle)}`);
  if (index < iterations - 1) await quitApp();
}

const report = {
  passed: true,
  appPath,
  iterations,
  bundleIdentifier,
  menuBarIdentityMode,
  traySlot: "default-0",
  completedAt: new Date().toISOString(),
  results,
};
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

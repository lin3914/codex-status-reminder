"use strict";

const path = require("path");

const LEGACY_LAUNCH_AGENT_LABEL = "com.lindaozhi.codex-companion";
const LEGACY_LAUNCH_AGENT_FILENAME = `${LEGACY_LAUNCH_AGENT_LABEL}.plist`;

function loginItemOptions(settings = {}) {
  const openAtLogin = Boolean(settings.launchAtLogin);
  return {
    openAtLogin,
    // Login launches are intentionally silent. The application is a
    // menu-bar accessory (LSUIElement) and therefore has no Dock icon;
    // unexpected-exit recovery is separate.
    openAsHidden: openAtLogin
  };
}

function syncLoginItem(app, settings) {
  const options = loginItemOptions(settings);
  if (!app || typeof app.setLoginItemSettings !== "function") {
    return { supported: false, applied: false, options };
  }
  try {
    app.setLoginItemSettings(options);
    return { supported: true, applied: true, options };
  } catch (error) {
    return {
      supported: true,
      applied: false,
      options,
      error: String(error?.message || error || "Unable to update login item")
    };
  }
}

function loginItemStatus(app) {
  if (!app || typeof app.getLoginItemSettings !== "function") {
    return { supported: false, enabled: false };
  }
  try {
    const value = app.getLoginItemSettings() || {};
    return {
      supported: true,
      enabled: Boolean(value.openAtLogin),
      openAsHidden: Boolean(value.openAsHidden),
      raw: value
    };
  } catch (error) {
    return {
      supported: true,
      enabled: false,
      error: String(error?.message || error || "Unable to read login item")
    };
  }
}

function migrateLegacyLaunchAgent({
  home,
  uid,
  fsModule,
  execFileSync
} = {}) {
  if (
    typeof home !== "string"
    || !home
    || !Number.isInteger(uid)
    || !fsModule
    || typeof execFileSync !== "function"
  ) {
    return { supported: false, removed: false, reason: "invalid-environment" };
  }
  const agentPath = path.join(home, "Library", "LaunchAgents", LEGACY_LAUNCH_AGENT_FILENAME);
  if (!fsModule.existsSync(agentPath)) {
    return { supported: true, removed: false, reason: "not-present" };
  }

  let label;
  let program;
  try {
    label = String(execFileSync(
      "/usr/bin/plutil",
      ["-extract", "Label", "raw", "-o", "-", agentPath],
      { encoding: "utf8", timeout: 2_000 }
    )).trim();
    program = String(execFileSync(
      "/usr/bin/plutil",
      ["-extract", "ProgramArguments.0", "raw", "-o", "-", agentPath],
      { encoding: "utf8", timeout: 2_000 }
    )).trim();
  } catch (error) {
    return {
      supported: true,
      removed: false,
      reason: "unreadable",
      error: String(error?.message || error)
    };
  }

  const expectedProgramSuffix = path.join(
    "Codex Companion.app",
    "Contents",
    "MacOS",
    "Codex Companion"
  );
  if (
    label !== LEGACY_LAUNCH_AGENT_LABEL
    || !program.endsWith(expectedProgramSuffix)
  ) {
    return { supported: true, removed: false, reason: "not-owned" };
  }

  const serviceTarget = `gui/${uid}/${LEGACY_LAUNCH_AGENT_LABEL}`;
  let loaded = false;
  try {
    execFileSync("/bin/launchctl", ["print", serviceTarget], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: "ignore"
    });
    loaded = true;
  } catch {
    loaded = false;
  }
  if (loaded) {
    try {
      execFileSync("/bin/launchctl", ["bootout", serviceTarget], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: "ignore"
      });
    } catch (error) {
      return {
        supported: true,
        removed: false,
        reason: "bootout-failed",
        error: String(error?.message || error)
      };
    }
  }
  try {
    fsModule.unlinkSync(agentPath);
  } catch (error) {
    return {
      supported: true,
      removed: false,
      reason: "remove-failed",
      error: String(error?.message || error)
    };
  }
  return {
    supported: true,
    removed: true,
    reason: loaded ? "booted-out-and-removed" : "removed"
  };
}

module.exports = {
  LEGACY_LAUNCH_AGENT_LABEL,
  loginItemOptions,
  loginItemStatus,
  migrateLegacyLaunchAgent,
  syncLoginItem
};

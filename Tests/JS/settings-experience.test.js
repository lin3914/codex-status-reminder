"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/settings.html"),
  "utf8"
);
const main = fs.readFileSync(
  path.join(root, "ElectronApp/main.js"),
  "utf8"
);
const preload = fs.readFileSync(
  path.join(root, "ElectronApp/preload-settings.js"),
  "utf8"
);

assert.doesNotMatch(html, /id="onboarding"/);
assert.doesNotMatch(html, /name="onboarding-display"/);
assert.doesNotMatch(html, /id="onboarding-(continue|finish|notifications|login)"/);
assert.match(html, /<div id="settings-content">/);
assert.doesNotMatch(html, /<div id="settings-content" hidden>/);
assert.match(
  main,
  /const shouldPresentInitialSettings = !settings\.onboardingCompleted;[\s\S]*?persistSettings\([\s\S]*?shouldPresentInitialSettings \|\| process\.argv\.includes\("--show-settings"\)/,
  "a fresh install must open the full Settings page and complete the legacy launch marker automatically"
);

assert.equal(
  (html.match(/id="launchAtLogin"/g) || []).length,
  1,
  "the normal settings page must contain one login-startup control"
);
assert.match(
  html,
  /id="general-title"[\s\S]*?id="showDesktopWidget"[\s\S]*?id="launchAtLogin"/,
  "the only desktop visibility preference must be part of General"
);
assert.equal((html.match(/id="showMenuBarQuota"/g) || []).length, 1);
assert.match(html, /for="showMenuBarQuota"/);
assert.match(html, /id="showMenuBarQuota" type="checkbox" role="switch"/);
assert.match(html, /showMenuBarQuota: "菜单栏显示剩余周额度"/);
assert.match(html, /showMenuBarQuota: "Show weekly quota in menu bar"/);
assert.match(html, /const settingKeys = \[[\s\S]*?"showMenuBarQuota"/);
for (const removedControl of [
  "desktop-title",
  "display-mode-widget",
  "display-mode-menu",
  "showHoverPanel",
  "alwaysOnTop",
  "showOnAllWorkspaces",
  "reset-position",
  "recoverAfterCrash",
  "test-notification",
  "show-guide",
  "guide-dialog",
  "export-diagnostics",
  "restore-recommended"
]) {
  assert.doesNotMatch(
    html,
    new RegExp(`id="${removedControl}"`),
    `${removedControl} must not remain in Settings`
  );
}
assert.doesNotMatch(html, /权限与数据|Permissions & data/);
assert.doesNotMatch(html, /再次查看使用引导|Show usage guide again/);
assert.doesNotMatch(html, /id="launchAtBoot"/);
assert.doesNotMatch(html, /id="keepInBackground"/);
assert.match(html, /<option value="system"[^>]*>/);

assert.match(main, /function effectiveLocale\(/);
assert.match(html, /<h1 data-copy="appName">CodeX状态提醒<\/h1>/);
assert.match(html, /"zh-CN": \{[\s\S]*?appName: "CodeX状态提醒"/);
assert.match(html, /en: \{[\s\S]*?appName: "Codex Companion"/);
assert.match(main, /APP_INTERNAL_NAME = "Codex Companion"/);
assert.match(main, /APP_DISPLAY_NAME_ZH = "CodeX状态提醒"/);
assert.match(main, /app\.setName\(APP_INTERNAL_NAME\)/);

assert.match(main, /backgroundRecovery\.start\(true\)/);
assert.match(main, /win\.setAlwaysOnTop\(true, DESKTOP_WIDGET_ALWAYS_ON_TOP_LEVEL\)/);
assert.match(
  main,
  /win\.setVisibleOnAllWorkspaces\(true, \{[\s\S]*?visibleOnFullScreen: false/,
  "the desktop dot must appear across Spaces but not inside full-screen apps"
);
assert.match(
  main,
  /function handleEnter\(\) \{\s*clearHoverCloseTimer\(\)/,
  "desktop-dot hover must always expand the task panel"
);
assert.doesNotMatch(main, /command === "show-panel-hover"/);
assert.doesNotMatch(main, /command === "hide-panel-hover"/);
assert.doesNotMatch(main, /settings\.showHoverPanel|settings\.alwaysOnTop|settings\.showOnAllWorkspaces|settings\.recoverAfterCrash/);
assert.doesNotMatch(main, /settings-reset-position|settings-test-notification|settings-export-diagnostics|settings-restore-recommended/);
assert.doesNotMatch(preload, /resetPosition|testNotification|restoreRecommended|exportDiagnostics/);

for (const leadDays of ["0.25", "0.5", "1"]) {
  assert.match(html, new RegExp(`data-healthy="${leadDays}"`));
}
assert.equal(
  (html.match(/class="quota-segment /g) || []).length,
  3,
  "quota health must use three named ranges"
);
assert.match(html, /id="custom-warning-enabled"/);
assert.match(html, /quotaHealthyLeadDays \?\? 0\.5/, "zero hours must not render as the 12-hour default");
assert.match(html, /quotaWarningLeadDays/);
assert.match(html, /正常使用/);
assert.match(html, /需留意/);
assert.match(html, /额度告警/);
assert.match(html, /id="notification-delivery"/);

assert.match(html, /connection\.manualSelectionAvailable !== true/);
assert.match(html, /id="connection-last-sync"/);
assert.match(preload, /retryCodexConnection/);
assert.match(preload, /openCodex/);
assert.match(html, /id="menu-bar-warning"/);
assert.doesNotMatch(html, /id="onboarding-menu-bar-warning"/);
assert.match(html, /id="open-menu-bar-settings"/);
assert.match(html, /不需要还原整个控制中心/);
assert.match(html, /Do not reset Control Center/);
assert.doesNotMatch(
  html,
  /请选择“还原控制中心|choose Reset Control Center/,
  "missing menu-bar items must not instruct users to reset unrelated system preferences"
);
assert.match(html, /state\.settings\.menuBarStatus\?\.state === "system-hidden"/);
assert.match(preload, /openMenuBarSettings/);
assert.match(main, /function menuBarStatusSnapshot\(\)/);
assert.match(main, /companion:settings-open-menu-bar-settings/);
assert.match(
  main,
  /x-apple\.systempreferences:com\.apple\.ControlCenter-Settings\.extension/,
  "menu-bar recovery must open the public System Settings surface"
);
assert.doesNotMatch(main, /Flux Island|FLUX_SETTINGS_PATH/);

assert.match(
  main,
  /SETTINGS_MIGRATION_BACKUP_PATH[\s\S]*?settings-before-schema-5\.json/
);
assert.match(main, /screen\.on\("display-added", handleDisplayLayoutChange\)/);
assert.match(main, /screen\.on\("display-removed", handleDisplayLayoutChange\)/);
assert.match(
  main,
  /case "dragEnd":[\s\S]*?reconcileDesktopWidgetPosition\(\)/,
  "drag completion must clamp and persist a visible widget position"
);
assert.match(
  main,
  /if \(localeChanged\) sendCompletionBannerContent\(\)/,
  "visible completion alerts must follow language changes"
);
assert.match(
  main,
  /if \(localeChanged\) \{[\s\S]*?settingsWindow\.setTitle\(appName\)/,
  "settings window title must follow interface language changes"
);

console.log("PASS settings-experience");

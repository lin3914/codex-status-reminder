"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const projectDirectory = path.resolve(__dirname, "../..");
const mainSource = fs.readFileSync(
  path.join(projectDirectory, "ElectronApp/main.js"),
  "utf8"
);
const buildSource = fs.readFileSync(
  path.join(projectDirectory, "scripts/build-electron-app.sh"),
  "utf8"
);
const iconGeneratorSource = fs.readFileSync(
  path.join(projectDirectory, "scripts/generate-icon-assets.mjs"),
  "utf8"
);
const settingsSource = fs.readFileSync(
  path.join(projectDirectory, "Resources/LegacyV11/settings.html"),
  "utf8"
);
const sourceInfo = fs.readFileSync(
  path.join(projectDirectory, "Resources/Info.plist"),
  "utf8"
);

assert.doesNotMatch(mainSource, /command === "show-panel-hover"/);
assert.doesNotMatch(mainSource, /command === "hide-panel-hover"/);
assert.match(mainSource, /command === "show-tray-summary"/);
assert.doesNotMatch(mainSource, /app\.setActivationPolicy\(/);
assert.match(
  sourceInfo,
  /<key>LSUIElement<\/key>\s*<true\/>/,
  "the Tray must be hosted by a menu-bar accessory application"
);
assert.match(
  mainSource,
  /visibleOnFullScreen: false,[\s\S]*?skipTransformProcessType: true/,
  "desktop widget windows must not promote the accessory into the Dock"
);
assert.match(
  mainSource,
  /visibleOnFullScreen: true,[\s\S]*?skipTransformProcessType: true/,
  "completion banners must not promote the accessory into the Dock"
);
assert.match(
  mainSource,
  /new Tray\(menuBarTrayImage\)/,
  "the standard app process must own the macOS menu-bar item"
);
assert.doesNotMatch(
  mainSource,
  /menuBarTray\.on\("mouse-(enter|leave)"/,
  "menu-bar hover must not open or close a panel"
);
assert.doesNotMatch(settingsSource, /Show task panel on hover|悬停显示任务面板/);
assert.match(mainSource, /menuBarTray\.on\("click"/);
assert.match(mainSource, /toggleTrayPanel\(bounds\)/);
assert.match(mainSource, /menuBarTray\.on\("right-click"/);
assert.match(mainSource, /menuBarTray\.popUpContextMenu/);
assert.match(mainSource, /image\.setTemplateImage\(true\)/);
assert.match(
  mainSource,
  /displayName: copyFor\(\)\.appName/,
  "menu-bar runtime diagnostics must expose the localized display name"
);
assert.match(mainSource, /MENU_BAR_IDENTITY_MODE = "bundle-default-slot-v7"/);
assert.doesNotMatch(
  mainSource,
  /MENU_BAR_TRAY_GUID|new Tray\(menuBarTrayImage,/
);
assert.match(mainSource, /APP_BUNDLE_IDENTIFIER = "com\.lindaozhi\.codexstatusreminder"/);
assert.match(mainSource, /ensureMenuBarTray\("app-ready"\)/);
assert.match(mainSource, /ensureMenuBarTray\("second-instance"\)/);
assert.match(mainSource, /ensureMenuBarTray\("app-activate"\)/);
assert.match(mainSource, /MENU_BAR_HEALTH_MS = 60_000/);
assert.match(mainSource, /powerMonitor\.on\("resume"/);
assert.match(mainSource, /powerMonitor\.on\("unlock-screen"/);
assert.match(mainSource, /"user-did-become-active"/);
assert.match(mainSource, /scheduleMenuBarRetry/);
assert.match(mainSource, /trayRecoveryCount/);
assert.match(mainSource, /--self-test-menu-bar-recovery/);
assert.match(mainSource, /ensureMenuBarTray\("self-test-recovery"\)/);
assert.match(mainSource, /trayBoundsVisible/);
assert.match(mainSource, /trayBoundsInMenuBar/);
assert.match(mainSource, /trayTouchesDisplayRightEdge/);
assert.match(mainSource, /trayPlacementState/);
assert.match(mainSource, /menuBarDisplayForBounds/);
assert.match(mainSource, /MENU_BAR_PLACEMENT_GRACE_MS = 4_000/);
assert.match(mainSource, /autoRecreateOnPlacementFailure: false/);
assert.doesNotMatch(mainSource, /recoverMenuBarTrayPlacement|MENU_BAR_PLACEMENT_RECOVERY_LIMIT|MENU_BAR_BLOCKED_RETRY_MS/);
assert.doesNotMatch(mainSource, /setTitle\("\\u2060"\)/);
assert.match(mainSource, /destroyMenuBarTray\(\)/);
assert.match(mainSource, /tray-system-hidden:/);
assert.match(mainSource, /trayDisplay: menuBarDisplay \?/);
assert.match(mainSource, /imageTemplate: menuBarTrayImage\?\.isTemplateImage\(\)/);
assert.match(mainSource, /now - menuBarLastLeftEventAt < 250/);
assert.match(mainSource, /leftClickHandledCount/);
assert.doesNotMatch(mainSource, /app\.getBundleId/);
assert.doesNotMatch(mainSource, /startMenuBarHelper/);
assert.doesNotMatch(buildSource, /NativeMenuBar\/main\.swift/);
assert.doesNotMatch(mainSource, /requestControlCenterRelayout/);
assert.doesNotMatch(mainSource, /com\.apple\.controlcenter/);
assert.doesNotMatch(
  mainSource,
  /com\.apple\.controlcenter/,
  "menu-bar recovery must not mutate private Control Center state"
);

assert.match(
  iconGeneratorSource,
  /function drawTrayIcon\(size\)\s*\{[\s\S]*?drawLogo04Icon\(size, \{[\s\S]*?background: false,[\s\S]*?monochrome: true,[\s\S]*?\}\);/
);
assert.match(
  iconGeneratorSource,
  /const starPoints = createStarPoints\(0\.5, 0\.5, 0\.24, 0\.072, -70\)/,
  "menu glyph must retain the shared tilted central star"
);

console.log("PASS menu-bar-interaction");

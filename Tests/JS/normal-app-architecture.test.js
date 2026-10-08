"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "ElectronApp/main.js"), "utf8");
const sourceInfo = fs.readFileSync(
  path.join(root, "Resources/Info.plist"),
  "utf8"
);
const build = fs.readFileSync(
  path.join(root, "scripts/build-electron-app.sh"),
  "utf8"
);
const installer = fs.readFileSync(path.join(root, "scripts/install-app.sh"), "utf8");
const recovery = fs.readFileSync(
  path.join(root, "ElectronApp/background-recovery.js"),
  "utf8"
);
const quotaProvider = fs.readFileSync(
  path.join(root, "ElectronApp/codex-quota-provider.js"),
  "utf8"
);
const quotaClient = fs.readFileSync(
  path.join(root, "ElectronApp/quota-data-client.js"),
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
const nativeRecovery = fs.readFileSync(
  path.join(root, "NativeRecovery/main.swift"),
  "utf8"
);
const settings = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/settings.html"),
  "utf8"
);
const releasePackaging = fs.readFileSync(
  path.join(root, "scripts/package-macos-release.sh"),
  "utf8"
);
const releaseCheck = fs.readFileSync(
  path.join(root, "scripts/check-release-readiness.sh"),
  "utf8"
);
const restartValidator = fs.readFileSync(
  path.join(root, "scripts/validate-menu-bar-restarts.mjs"),
  "utf8"
);
const packageJSON = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const developmentRequirement = fs.readFileSync(
  path.join(root, "Resources/DevelopmentDesignatedRequirement.req"),
  "utf8"
).trim();

assert.match(main, /dialog\.showOpenDialog/, "Codex folder must be user-selectable");
assert.match(main, /selectedFolderConnection/, "selected folder must drive the reader");
assert.match(main, /automaticCodexConnection/, "Codex data must be discovered automatically");
assert.match(
  main,
  /resolveSelectedCodexFolder/,
  "manual fallback must validate the selected Codex data folder"
);
assert.match(main, /syncLoginItem\(app, settings\)/, "login must use the app service");
assert.doesNotMatch(main, /app\.setActivationPolicy\(/);
assert.match(
  sourceInfo,
  /<key>CFBundleName<\/key>\s*<string>Codex Companion<\/string>/,
  "the technical bundle name must match Electron's helper bundle names"
);
assert.match(
  sourceInfo,
  /<key>LSUIElement<\/key>\s*<true\/>/,
  "the production app must declare the menu-bar accessory lifecycle"
);
assert.match(
  main,
  /visibleOnFullScreen: false,[\s\S]*?skipTransformProcessType: true/,
  "desktop widget workspace promotion must not re-register a Dock tile"
);
assert.match(
  main,
  /visibleOnFullScreen: true,[\s\S]*?skipTransformProcessType: true/,
  "completion banner workspace promotion must not re-register a Dock tile"
);
assert.match(
  build,
  /Set :LSUIElement bool true/,
  "packaged builds must retain the menu-bar accessory identity"
);
assert.match(
  build,
  /xattr -cr \"\$app_root\"/,
  "packaged builds must clear synced resource metadata before signing"
);
assert.match(
  installer,
  /source_app=\"\$\{CODEX_COMPANION_APP_OUTPUT:-/,
  "the installer must support a local signed build output"
);
assert.match(
  build,
  /\.build\/products\/CodeX状态提醒\.app/,
  "the default generated bundle must use the selected Chinese product name"
);
assert.match(
  build,
  /Set :CFBundleDisplayName CodeX状态提醒[\s\S]*?Set :CFBundleName Codex Companion/,
  "the visible Chinese name and Electron helper identity must stay deliberately separate"
);
assert.match(main, /\bTray\b/);
assert.match(main, /APP_BUNDLE_IDENTIFIER = "com\.lindaozhi\.codexstatusreminder"/);
assert.match(
  main,
  /LEGACY_APP_BUNDLE_IDENTIFIERS[\s\S]*?com\.lindaozhi\.codexcompanion\.app/,
  "the final app identity must explicitly migrate only known pre-release identities"
);
assert.match(main, /menuBarImplementation: "electron-main-tray"/);
assert.match(main, /MENU_BAR_IDENTITY_MODE = "bundle-default-slot-v7"/);
assert.match(
  main,
  /new Tray\(menuBarTrayImage\)/,
  "the menu item must use the standard single-Tray macOS contract"
);
assert.doesNotMatch(
  main,
  /MENU_BAR_TRAY_GUID|new Tray\(menuBarTrayImage,|setTitle\("\\u2060"\)/,
  "the app must not change a live macOS status-item identity after creation"
);
assert.match(main, /trayBoundsInMenuBar/);
assert.match(main, /trayTouchesDisplayRightEdge/);
assert.match(main, /tray-system-hidden:/);
assert.match(main, /autoRecreateOnPlacementFailure: false/);
assert.doesNotMatch(main, /recoverMenuBarTrayPlacement|MENU_BAR_PLACEMENT_RECOVERY_LIMIT|MENU_BAR_BLOCKED_RETRY_MS/);
assert.match(main, /ensureMenuBarTray/);
assert.doesNotMatch(main, /startMenuBarHelper/);
assert.doesNotMatch(
  main,
  /class AppServerClient|account\/rateLimits\/read|childProcess\.spawn\([^)]*app-server/s,
  "the menu-bar main thread must not host the Codex protocol process"
);
assert.match(
  main,
  /fetchCodexQuota/,
  "quota must retain the isolated compatibility provider"
);
assert.match(
  main,
  /fetchOfficial:\s*\(\) => ensureQuotaDataClient\(\)\.refresh\(\)[\s\S]*?fetchCompatibility:[\s\S]*?fetchCodexQuota/,
  "the official provider must run before the compatibility provider"
);
assert.match(quotaClient, /new Worker\(this\.workerPath\(\)/);
assert.match(quotaWorker, /normalizeAppServerPayload/);
assert.match(appServerClient, /account\/rateLimits\/read/);
assert.match(
  appServerClient,
  /\["app-server", "--listen", "stdio:\/\/"\]/,
  "the official protocol must use the portable stdio transport"
);
assert.match(
  appServerClient,
  /experimentalApi:\s*false/,
  "the quota reader must stay on the non-experimental method surface"
);
assert.match(quotaProvider, /backend-api\/wham\/usage/);
assert.match(quotaProvider, /path\.join\(codexHome,\s*"auth\.json"\)/);
assert.doesNotMatch(
  quotaProvider,
  /child_process|app-server|writeFile|appendFile/,
  "the compatibility provider must not launch Codex or write into Codex data"
);
assert.match(main, /QUOTA_CACHE_PATH/);
assert.match(main, /QUOTA_REFRESH_MS = 5 \* 60_000/);
assert.doesNotMatch(main, /Codex Companion Menu Bar\.app/);
assert.doesNotMatch(build, /NativeMenuBar\/main\.swift/);
assert.match(
  build,
  /rm -rf "\$app_root\/Contents\/Helpers\/Codex Companion Menu Bar\.app"/,
  "a previous nested menu host must never leak into the generated app"
);
assert.doesNotMatch(main, /com\.apple\.controlcenter/);
assert.doesNotMatch(main, /killall\s+Finder/);
assert.doesNotMatch(main, /persistLaunchAgent/);
assert.doesNotMatch(main, /sandbox:\s*false/);
assert.doesNotMatch(installer, /launchctl/);
assert.doesNotMatch(installer, /killall\s+Finder/);
assert.doesNotMatch(installer, /xattr -dr/);
assert.match(
  restartValidator,
  /tell application "Finder" to open/,
  "restart validation must launch the production identity through Finder"
);
assert.match(
  restartValidator,
  /runningMainProcessIDs[\s\S]*?waitForMainProcessStart/,
  "restart validation must observe the actual Electron main process as well as its runtime file"
);
assert.match(
  restartValidator,
  /if \(!active && mainProcessIDs\.length === 0\) return;/,
  "restart validation must wait for a previous main process to exit before requesting another Finder launch"
);
assert.doesNotMatch(
  restartValidator,
  /run\("\/usr\/bin\/open"/,
  "restart validation must not attribute the status item to a terminal host"
);
assert.match(
  installer,
  /product_app_name="CodeX状态提醒"[\s\S]*?legacy_app_name="Codex Companion"/,
  "the installer must migrate the previous English bundle into the selected Chinese product name"
);
assert.match(
  installer,
  /default_target_app="\/Applications\/\$product_app_name\.app"/,
  "the default installed app path must use the selected Chinese product name"
);
assert.match(
  installer,
  /legacy_bundle_ids=[\s\S]*?com\.lindaozhi\.codexcompanion\.app/,
  "only the app's own previous bundle may be migrated or removed"
);
assert.match(
  installer,
  /is_owned_legacy_app[\s\S]*?\[\[ "\$executable" == "Codex Companion" \]\]/,
  "legacy migration must also require the expected Electron executable"
);
assert.match(
  installer,
  /clear_legacy_status_item_preferences[\s\S]*?com\.lindaozhi\.codex-companion\.menu-bar\.v2/,
  "upgrades must clear only retired app-owned status-item preferences"
);
assert.match(
  installer,
  /clear_legacy_menu_bar_diagnostics[\s\S]*?menu-bar-runtime\.json[\s\S]*?menu-bar-runtime-v2-\*\.json\.lock/,
  "upgrades must remove only obsolete fixed-name menu-bar diagnostics"
);
assert.match(
  installer,
  /clear_legacy_status_item_preferences\nclear_legacy_menu_bar_diagnostics\nswap_active=true/,
  "legacy diagnostics must be cleaned before the one-time app swap"
);
assert.doesNotMatch(
  installer,
  /com\.apple\.controlcenter/,
  "the installer must not mutate macOS private Control Center state"
);
assert.match(
  installer,
  /pkill -f "\^\$legacy_menu_executable\( \|\$\)"/,
  "installer must stop the argument-bearing menu host from the app being replaced"
);
assert.match(
  installer,
  /recovery_helper[\s\S]*?pkill -f "\^\$recovery_helper\( \|\$\)"/,
  "installer must stop the app-owned recovery helper before replacing an app bundle"
);
assert.match(
  installer,
  /unregister_replaced_bundle "\$target_app"[\s\S]*?\/bin\/mv "\$staged_app" "\$target_app"/,
  "installer must unregister the replaced app and nested host before the swap"
);
assert.match(
  installer,
  /install_transaction_dir="\$install_parent\/\.\$product_app_name\.installing\.\$\$\.transaction"[\s\S]*?staged_app="\$install_transaction_dir\/payload"/,
  "the installer must stage outside of an *.app path so LaunchServices cannot retain a second application"
);
assert.match(
  installer,
  /cleanup_orphaned_legacy_staging_apps[\s\S]*?for app_name in "\$product_app_name" "\$legacy_app_name"[\s\S]*?for artifact_kind in installing backup failed[\s\S]*?is_owned_legacy_app "\$candidate"[\s\S]*?\/bin\/rm -rf "\$candidate"/,
  "upgrades must remove only verified legacy hidden staging apps"
);
assert.match(
  installer,
  /if \[\[ -d "\$install_transaction_dir" \]\]; then \/bin\/rm -rf "\$install_transaction_dir"; fi/,
  "every installer exit path must clear its own transaction directory"
);
assert.doesNotMatch(
  installer,
  /installed_menu_host[\s\S]*?launch_services_register" -f "\$installed_menu_host/,
  "the installed app must not register a second menu-host application"
);
assert.match(main, /syncBackgroundRecovery\(\)/);
assert.match(recovery, /BackgroundRecovery/);
assert.match(main, /BACKGROUND_RECOVERY_STABILITY_MS = 30_000/);
assert.match(recovery, /background-recovery-crash-state\.json/);
assert.match(nativeRecovery, /DispatchSource\.makeProcessSource/);
assert.match(nativeRecovery, /NSWorkspace\.shared\.openApplication/);
assert.match(nativeRecovery, /maximumUnexpectedExitRestarts = 2/);
assert.match(nativeRecovery, /crashWindow: TimeInterval = 90/);
assert.doesNotMatch(recovery, /launchctl/);
assert.doesNotMatch(nativeRecovery, /launchctl/);
assert.match(settings, /choose-codex-folder/);
assert.match(settings, /restore-codex-folder/);
assert.match(build, /CODEX_COMPANION_TARGET_ARCH/);
assert.match(build, /ELECTRON_TARGET_ARCH/);
assert.match(build, /expected_electron_version/);
assert.match(
  build,
  /--requirements "\$development_requirement"/,
  "development builds must retain one stable macOS code identity"
);
assert.equal(
  developmentRequirement,
  'designated => identifier "com.lindaozhi.codexstatusreminder"',
  "development identity must be scoped to Codex Companion"
);
assert.doesNotMatch(
  build,
  /Applications\/Flux Island\.app/,
  "a release build must never borrow another installed app as its runtime"
);
assert.match(releasePackaging, /target_arches=\(arm64 x86_64\)/, "default release still builds both architectures");
assert.match(releasePackaging, /CODEX_COMPANION_RELEASE_ARCHS/, "a build host may explicitly select a supported architecture");
assert(releasePackaging.includes('for target_arch in "${target_arches[@]}"'));
assert(releasePackaging.includes('[[ "$target_arch" == "arm64" || "$target_arch" == "x86_64" ]]'));
assert.match(releasePackaging, /CodeX状态提醒\.app/);
assert.match(releasePackaging, /CODEX_COMPANION_SIGN_IDENTITY/);
assert.match(releasePackaging, /CODEX_COMPANION_NOTARY_PROFILE/);
assert.match(releasePackaging, /stapler staple/);
assert.match(releaseCheck, /CODEX_COMPANION_DISTRIBUTION/);
assert.match(releaseCheck, /Developer ID Application/);
assert.ok(
  Number(packageJSON.devDependencies.electron.split(".")[0]) >= 43,
  "public builds must use a currently supported Electron major"
);

console.log("PASS normal-app-architecture");

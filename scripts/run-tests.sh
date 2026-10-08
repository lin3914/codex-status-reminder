#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
test_binary="$project_dir/.build/codex-companion-self-test"

/usr/bin/env node --check "$project_dir/ElectronApp/main.js"
/usr/bin/env node --check "$project_dir/ElectronApp/codex-ipc-status.js"
/usr/bin/env node --check "$project_dir/ElectronApp/task-data-client.js"
/usr/bin/env node --check "$project_dir/ElectronApp/task-data-worker.js"
/usr/bin/env node --check "$project_dir/ElectronApp/codex-discovery.js"
/usr/bin/env node --check "$project_dir/ElectronApp/codex-state.js"
/usr/bin/env node --check "$project_dir/ElectronApp/task-classification.js"
/usr/bin/env node --check "$project_dir/ElectronApp/quota-health.js"
/usr/bin/env node --check "$project_dir/ElectronApp/codex-quota-provider.js"
/usr/bin/env node --check "$project_dir/ElectronApp/codex-app-server-client.js"
/usr/bin/env node --check "$project_dir/ElectronApp/quota-data-client.js"
/usr/bin/env node --check "$project_dir/ElectronApp/quota-data-worker.js"
/usr/bin/env node --check "$project_dir/ElectronApp/settings-store.js"
/usr/bin/env node --check "$project_dir/ElectronApp/codex-connection.js"
/usr/bin/env node --check "$project_dir/ElectronApp/system-services.js"
/usr/bin/env node --check "$project_dir/ElectronApp/background-recovery.js"
/usr/bin/env node --check "$project_dir/ElectronApp/completion-notifications.js"
/usr/bin/env node --check "$project_dir/ElectronApp/frontmost-app.js"
/usr/bin/env node --check "$project_dir/ElectronApp/tray-icon.js"
/usr/bin/env node --check "$project_dir/ElectronApp/preload-dot.js"
/usr/bin/env node --check "$project_dir/ElectronApp/preload-panel.js"
/usr/bin/env node --check "$project_dir/ElectronApp/preload-settings.js"
/usr/bin/env node --check "$project_dir/ElectronApp/preload-notification.js"
/usr/bin/env node --check "$project_dir/scripts/generate-icon-assets.mjs"
/usr/bin/env node "$project_dir/Tests/JS/task-classification.test.js"
/usr/bin/env node "$project_dir/Tests/JS/codex-ipc-status.test.js"
/usr/bin/env node "$project_dir/Tests/JS/task-data-worker.test.js"
/usr/bin/env node "$project_dir/Tests/JS/quota-health.test.js"
/usr/bin/env node "$project_dir/Tests/JS/codex-quota-provider.test.js"
/usr/bin/env node "$project_dir/Tests/JS/codex-app-server-client.test.js"
/usr/bin/env node "$project_dir/Tests/JS/quota-data-worker.test.js"
/usr/bin/env node "$project_dir/Tests/JS/settings-store.test.js"
/usr/bin/env node "$project_dir/Tests/JS/settings-experience.test.js"
/usr/bin/env node "$project_dir/Tests/JS/codex-connection.test.js"
/usr/bin/env node "$project_dir/Tests/JS/system-services.test.js"
/usr/bin/env node "$project_dir/Tests/JS/background-recovery.test.js"
/usr/bin/env node "$project_dir/Tests/JS/completion-notifications.test.js"
/usr/bin/env node "$project_dir/Tests/JS/notification-contract.test.js"
/usr/bin/env node "$project_dir/Tests/JS/notification-lifecycle.test.js"
/usr/bin/env node "$project_dir/Tests/JS/notification-pressure.test.js"
/usr/bin/env node "$project_dir/Tests/JS/unread-presentation.test.js"
/usr/bin/env node "$project_dir/Tests/JS/frontmost-app.test.js"
/usr/bin/env node "$project_dir/Tests/JS/notification-layout.test.js"
/usr/bin/env node "$project_dir/Tests/JS/panel-state-style.test.js"
/usr/bin/env node "$project_dir/Tests/JS/panel-drag.test.js"
/usr/bin/env node "$project_dir/Tests/JS/panel-lifecycle.test.js"
/usr/bin/env node "$project_dir/Tests/JS/panel-incremental.test.js"
/usr/bin/env node "$project_dir/Tests/JS/menu-bar-interaction.test.js"
/usr/bin/env node "$project_dir/Tests/JS/tray-icon.test.js"
/usr/bin/env node "$project_dir/Tests/JS/menu-bar-quota.test.js"
/usr/bin/env node "$project_dir/Tests/JS/app-icon-direction.test.js"
/usr/bin/env node "$project_dir/Tests/JS/gradient-smoothing.test.js"
/usr/bin/env node "$project_dir/Tests/JS/codex-compatibility.test.js"
/usr/bin/env node "$project_dir/Tests/JS/resource-efficiency.test.js"
/usr/bin/env node "$project_dir/Tests/JS/normal-app-architecture.test.js"
/usr/bin/env node "$project_dir/Tests/JS/public-release.test.mjs"
/usr/bin/env node "$project_dir/Tests/JS/renderer-security.test.mjs"
/usr/bin/env node --check "$project_dir/scripts/validate-live-electron.mjs"
/usr/bin/env node --check "$project_dir/scripts/validate-live-notification-group.mjs"
/usr/bin/env node --check "$project_dir/scripts/run-notification-tests.mjs"
/usr/bin/env node --check "$project_dir/Tests/Electron/notification-delivery.cjs"
/usr/bin/env node --check "$project_dir/scripts/validate-menu-bar-restarts.mjs"
/usr/bin/env node --check "$project_dir/scripts/validate-menu-bar-quota.mjs"
/usr/bin/env node --check "$project_dir/scripts/validate-panel-latency.mjs"
/usr/bin/env node --check "$project_dir/scripts/validate-panel-lifecycle-live.mjs"
/usr/bin/xcrun swiftc -typecheck "$project_dir/scripts/panel-window-probe.swift"
/usr/bin/env node --check "$project_dir/scripts/sign-macos-app.mjs"
/usr/bin/env node --check "$project_dir/scripts/notarize-macos-app.mjs"
/usr/bin/xcrun swiftc \
  -parse-as-library \
  -typecheck \
  -target "$(/usr/bin/uname -m)-apple-macos12.0" \
  "$project_dir/NativeMenuBar/main.swift"
/usr/bin/xcrun swiftc \
  -typecheck \
  -target "$(/usr/bin/uname -m)-apple-macos12.0" \
  "$project_dir/NativeRecovery/main.swift"

dot_css="$project_dir/Resources/LegacyV11/pet-status-dot.css"
panel_css="$project_dir/Resources/LegacyV11/pet-panel.css"
[[ -f "$dot_css" && -f "$panel_css" ]]
[[ -f "$project_dir/Resources/LegacyV11/settings.html" ]]
[[ -f "$project_dir/Resources/LegacyV11/settings.css" ]]
/usr/bin/env rg -q -- "--time-ring-start: #65e6ef" "$dot_css"
/usr/bin/env rg -q -- "--time-ring-mid: #49d7e9" "$dot_css"
/usr/bin/env rg -q -- "--time-ring-end: #28a6de" "$dot_css"
/usr/bin/env rg -q -- "--quota-ring-start: #69eeae" "$dot_css"
/usr/bin/env rg -q -- "--quota-ring-mid: #45dda0" "$dot_css"
/usr/bin/env rg -q -- "--quota-ring-end: #27cc8f" "$dot_css"
/usr/bin/env rg -q "time-ring-gradient-mid" "$project_dir/Resources/LegacyV11/dot.html"
/usr/bin/env rg -q "quota-ring-gradient-mid" "$project_dir/Resources/LegacyV11/dot.html"
/usr/bin/env rg -q "healthProgress" "$project_dir/ElectronApp/quota-health.js"
/usr/bin/env rg -q "applyHealthColors" "$project_dir/Resources/LegacyV11/dot.html"
/usr/bin/env rg -q "status-health-badge" "$panel_css"
/usr/bin/env rg -q "quotaHealthyLeadDays" "$project_dir/Resources/LegacyV11/settings.html"
/usr/bin/env rg -q "leadDays" "$project_dir/ElectronApp/quota-health.js"
/usr/bin/env rg -q "CodexCompanionTemplate@2x.png" "$project_dir/ElectronApp/tray-icon.js"
/usr/bin/env rg -q "CodexCompanionTemplate.png" "$project_dir/scripts/build-electron-app.sh"
! /usr/bin/env rg -q 'app\.setActivationPolicy\(' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -Fq 'new Tray(menuBarTrayImage)' "$project_dir/ElectronApp/main.js"
! /usr/bin/env rg -q 'MENU_BAR_TRAY_GUID|new Tray\(menuBarTrayImage,' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -Fq 'menuBarTray.on("click"' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -Fq 'menuBarTray.on("right-click"' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -Fq 'image.setTemplateImage(true)' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -q 'trayBoundsVisible' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -q 'trayBoundsInMenuBar' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -q 'trayTouchesDisplayRightEdge' "$project_dir/ElectronApp/main.js"
/usr/bin/env rg -q "CFBundleIconFile icon.icns" "$project_dir/scripts/build-electron-app.sh"
! /usr/bin/env rg -q "com\\.apple\\.controlcenter" "$project_dir/ElectronApp/main.js"
! /usr/bin/env rg -q "startMenuBarHelper" "$project_dir/ElectronApp/main.js"
! /usr/bin/env rg -q "NativeMenuBar/main.swift" "$project_dir/scripts/build-electron-app.sh"
! /usr/bin/env rg -q "launchctl" "$project_dir/scripts/install-app.sh"
! /usr/bin/env rg -q "killall Finder" "$project_dir/scripts/install-app.sh"
! /usr/bin/env rg -q "sandbox: false" "$project_dir/ElectronApp/main.js"
! /usr/bin/env rg -q "launchctl" "$project_dir/ElectronApp/background-recovery.js"
[[ -f "$project_dir/Resources/TrayIcon/CodexCompanionTemplate.png" ]]
[[ -f "$project_dir/Resources/TrayIcon/CodexCompanionTemplate@2x.png" ]]
[[ -f "$project_dir/Resources/LegacyV11/app-icon.png" ]]
! /usr/bin/env rg -q "setIgnoreMouseEvents" "$project_dir/ElectronApp/main.js"

/bin/mkdir -p "$project_dir/.build"
/usr/bin/swiftc \
  -parse-as-library \
  "$project_dir/Sources/CodexCompanion/Models.swift" \
  "$project_dir/Sources/CodexCompanion/CodexUnreadStateReader.swift" \
  "$project_dir/Sources/CodexCompanion/CodexAppServerClient.swift" \
  "$project_dir/Sources/CodexCompanion/CodexTranscriptReader.swift" \
  "$project_dir/Tests/SelfTest/SelfTest.swift" \
  -o "$test_binary"

"$test_binary"

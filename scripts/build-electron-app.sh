#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
current_arch=$(/usr/bin/uname -m)
target_arch="${CODEX_COMPANION_TARGET_ARCH:-$current_arch}"
case "$target_arch" in
  arm64)
    electron_arch="arm64"
    swift_arch="arm64"
    ;;
  x64|x86_64)
    electron_arch="x64"
    swift_arch="x86_64"
    target_arch="x86_64"
    ;;
  *)
    echo "Unsupported target architecture: $target_arch" >&2
    exit 1
    ;;
esac
app_root="${CODEX_COMPANION_APP_OUTPUT:-$project_dir/.build/products/CodeX状态提醒.app}"
stage_dir="${CODEX_COMPANION_STAGE_OUTPUT:-$project_dir/.build/electron-package-$target_arch}"
resources_dir="$app_root/Contents/Resources"
info_plist="$app_root/Contents/Info.plist"
app_icon="$project_dir/Resources/AppIcon/icon.icns"
tray_icon_dir="$project_dir/Resources/TrayIcon"
recovery_source="$project_dir/NativeRecovery/main.swift"
development_requirement="$project_dir/Resources/DevelopmentDesignatedRequirement.req"
dot_css="$project_dir/Resources/LegacyV11/pet-status-dot.css"
panel_css="$project_dir/Resources/LegacyV11/pet-panel.css"
node_binary=$(/usr/bin/env which node)
product_name="Codex Companion"
electron_package="$project_dir/node_modules/electron/package.json"
electron_recovery_root="$project_dir/.build/electron-runtime-$target_arch"
expected_electron_version=$(
  "$node_binary" -p "require(process.argv[1]).version" "$electron_package"
)
/usr/bin/env node "$script_dir/validate-build-paths.mjs" \
  "$project_dir" "$app_root" "$stage_dir" "$electron_recovery_root"

valid_electron_template() {
  local candidate="$1"
  [[ -d "$candidate" \
    && -f "$candidate/Contents/Info.plist" \
    && -d "$candidate/Contents/Frameworks" ]] \
    || return 1
  /usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" \
    "$candidate/Contents/Info.plist" >/dev/null 2>&1
}

electron_template_supports_target() {
  local candidate="$1"
  local executable
  local arches
  local version
  version=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
      "$candidate/Contents/Info.plist" 2>/dev/null
  ) || return 1
  [[ "$version" == "$expected_electron_version" ]] || return 1
  executable=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" \
      "$candidate/Contents/Info.plist" 2>/dev/null
  ) || return 1
  arches=$(/usr/bin/lipo -archs "$candidate/Contents/MacOS/$executable" 2>/dev/null) \
    || return 1
  [[ " $arches " == *" $swift_arch "* ]]
}

template_candidates=()
if [[ -n "${CODEX_COMPANION_ELECTRON_TEMPLATE:-}" ]]; then
  template_candidates+=("$CODEX_COMPANION_ELECTRON_TEMPLATE")
fi
template_candidates+=(
  "$project_dir/node_modules/electron/dist/Electron.app"
)

template_app=""
for candidate in "${template_candidates[@]}"; do
  if valid_electron_template "$candidate" \
    && electron_template_supports_target "$candidate"; then
    template_app="$candidate"
    break
  fi
done
if [[ -z "$template_app" && -f "$electron_package" ]]; then
  electron_zip=$(
    ELECTRON_PACKAGE="$electron_package" \
      ELECTRON_TARGET_ARCH="$electron_arch" \
      "$node_binary" - <<'NODE'
const path = require("path");
const electronPackage = process.env.ELECTRON_PACKAGE;
const { downloadArtifact } = require("@electron/get");
const { version } = require(electronPackage);
downloadArtifact({
  version,
  artifactName: "electron",
  platform: process.platform,
  arch: process.env.ELECTRON_TARGET_ARCH,
  checksums: require(path.join(path.dirname(electronPackage), "checksums.json"))
}).then((zipPath) => process.stdout.write(zipPath)).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
  )
  /bin/rm -rf "$electron_recovery_root"
  /bin/mkdir -p "$electron_recovery_root"
  /usr/bin/ditto -x -k "$electron_zip" "$electron_recovery_root"
  recovered_template="$electron_recovery_root/Electron.app"
  if valid_electron_template "$recovered_template" \
    && electron_template_supports_target "$recovered_template"; then
    template_app="$recovered_template"
  fi
fi
if [[ -z "$template_app" ]]; then
  echo "Electron $expected_electron_version runtime for $target_arch was not found. Run npm ci or set CODEX_COMPANION_ELECTRON_TEMPLATE to a matching Electron.app." >&2
  exit 1
fi

asar_candidates=()
if [[ -n "${CODEX_COMPANION_ASAR_CLI:-}" ]]; then
  asar_candidates+=("$CODEX_COMPANION_ASAR_CLI")
fi
asar_candidates+=("$project_dir/node_modules/@electron/asar/bin/asar.mjs")
asar_cli=""
for candidate in "${asar_candidates[@]}"; do
  if [[ -f "$candidate" ]]; then
    asar_cli="$candidate"
    break
  fi
done
asar_module="${asar_cli:h:h}/lib/asar.js"
if [[ ! -f "$asar_cli" || ! -f "$asar_module" ]]; then
  echo "Electron ASAR packer not found. Install @electron/asar in the project or npm cache." >&2
  exit 1
fi
if [[ ! -f "$app_icon" ]]; then
  echo "Codex Companion app icon not found: $app_icon" >&2
  exit 1
fi
if [[ ! -f "$tray_icon_dir/CodexCompanionTemplate.png" \
  || ! -f "$tray_icon_dir/CodexCompanionTemplate@2x.png" \
  || ! -f "$tray_icon_dir/CodexQuotaStarTemplate.png" \
  || ! -f "$tray_icon_dir/CodexQuotaStarTemplate@2x.png" ]]; then
  echo "Codex Companion menu-bar template icons are missing" >&2
  exit 1
fi
if [[ ! -f "$recovery_source" ]]; then
  echo "Codex Companion recovery helper source is missing" >&2
  exit 1
fi
if [[ ! -f "$development_requirement" ]]; then
  echo "Codex Companion development designated requirement is missing" >&2
  exit 1
fi
if [[ ! -f "$dot_css" || ! -f "$panel_css" ]]; then
  echo "Codex Companion renderer styles are missing" >&2
  exit 1
fi

/bin/rm -rf "$app_root" "$stage_dir"
/bin/mkdir -p "${app_root:h}"
/usr/bin/ditto "$template_app" "$app_root"
# Older local builds bundled a second LSUIElement application solely to host
# NSStatusItem. The main Electron process now owns the documented Tray object,
# so never carry that nested application forward when an installed build is
# used as the runtime template.
/bin/rm -rf "$app_root/Contents/Helpers/Codex Companion Menu Bar.app"
template_executable=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$info_plist")
runtime_arches=$(/usr/bin/lipo -archs "$app_root/Contents/MacOS/$template_executable")
if [[ " $runtime_arches " != *" $swift_arch "* ]]; then
  echo "Electron runtime architecture mismatch: target=$target_arch, runtime=$runtime_arches" >&2
  exit 1
fi
helper_apps=("$app_root"/Contents/Frameworks/*\ Helper*.app(N))
if (( ${#helper_apps} == 0 )); then
  echo "Electron helper app not found in runtime template." >&2
  exit 1
fi
template_bundle_name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$info_plist")
if [[ "$template_executable" != "$product_name" ]]; then
  /bin/mv \
    "$app_root/Contents/MacOS/$template_executable" \
    "$app_root/Contents/MacOS/$product_name"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $product_name" "$info_plist"

for helper_app in "${helper_apps[@]}"; do
  helper_plist="$helper_app/Contents/Info.plist"
  helper_app_name="${helper_app:t:r}"
  helper_executable=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$helper_plist" 2>/dev/null \
      || true
  )
  if [[ -z "$helper_executable" ]]; then
    helper_executable="$helper_app_name"
    /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string $helper_executable" \
      "$helper_plist"
  fi
  helper_suffix="${helper_app_name#$template_bundle_name}"
  renamed_helper_name="$product_name$helper_suffix"
  renamed_helper_executable="${helper_executable/$template_bundle_name/$product_name}"
  if [[ "$helper_executable" != "$renamed_helper_executable" ]]; then
    /bin/mv \
      "$helper_app/Contents/MacOS/$helper_executable" \
      "$helper_app/Contents/MacOS/$renamed_helper_executable"
  fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $renamed_helper_executable" "$helper_plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $renamed_helper_name" "$helper_plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $renamed_helper_name" "$helper_plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $renamed_helper_name" "$helper_plist"
  case "$helper_suffix" in
    " Helper")
      helper_identifier="com.lindaozhi.codexstatusreminder.helper"
      ;;
    " Helper (GPU)")
      helper_identifier="com.lindaozhi.codexstatusreminder.helper.gpu"
      ;;
    " Helper (Plugin)")
      helper_identifier="com.lindaozhi.codexstatusreminder.helper.plugin"
      ;;
    " Helper (Renderer)")
      helper_identifier="com.lindaozhi.codexstatusreminder.helper.renderer"
      ;;
    *)
      echo "Unexpected Electron helper: $helper_app_name" >&2
      exit 1
      ;;
  esac
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $helper_identifier" "$helper_plist"
  renamed_helper_app="${helper_app:h}/$renamed_helper_name.app"
  if [[ "$helper_app" != "$renamed_helper_app" ]]; then
    /bin/mv "$helper_app" "$renamed_helper_app"
  fi
done
/bin/rm -rf "$resources_dir/app.asar" "$resources_dir/app.asar.unpacked"
/bin/mkdir -p "$stage_dir/renderer"

/bin/cp "$project_dir/ElectronApp/package.json" "$stage_dir/package.json"
/bin/cp "$project_dir/ElectronApp/main.js" "$stage_dir/main.js"
/bin/cp "$project_dir/ElectronApp/renderer-security.js" "$stage_dir/renderer-security.js"
/bin/cp "$project_dir/ElectronApp/codex-ipc-status.js" "$stage_dir/codex-ipc-status.js"
/bin/cp "$project_dir/ElectronApp/task-data-client.js" "$stage_dir/task-data-client.js"
/bin/cp "$project_dir/ElectronApp/task-data-worker.js" "$stage_dir/task-data-worker.js"
/bin/cp "$project_dir/ElectronApp/codex-discovery.js" "$stage_dir/codex-discovery.js"
/bin/cp "$project_dir/ElectronApp/codex-state.js" "$stage_dir/codex-state.js"
/bin/cp "$project_dir/ElectronApp/task-classification.js" "$stage_dir/task-classification.js"
/bin/cp "$project_dir/ElectronApp/quota-health.js" "$stage_dir/quota-health.js"
/bin/cp "$project_dir/ElectronApp/codex-quota-provider.js" "$stage_dir/codex-quota-provider.js"
/bin/cp "$project_dir/ElectronApp/codex-app-server-client.js" "$stage_dir/codex-app-server-client.js"
/bin/cp "$project_dir/ElectronApp/quota-data-client.js" "$stage_dir/quota-data-client.js"
/bin/cp "$project_dir/ElectronApp/quota-data-worker.js" "$stage_dir/quota-data-worker.js"
/bin/cp "$project_dir/ElectronApp/settings-store.js" "$stage_dir/settings-store.js"
/bin/cp "$project_dir/ElectronApp/codex-connection.js" "$stage_dir/codex-connection.js"
/bin/cp "$project_dir/ElectronApp/system-services.js" "$stage_dir/system-services.js"
/bin/cp "$project_dir/ElectronApp/background-recovery.js" "$stage_dir/background-recovery.js"
/bin/cp "$project_dir/ElectronApp/completion-notifications.js" "$stage_dir/completion-notifications.js"
/bin/cp "$project_dir/ElectronApp/frontmost-app.js" "$stage_dir/frontmost-app.js"
/bin/cp "$project_dir/ElectronApp/tray-icon.js" "$stage_dir/tray-icon.js"
/bin/cp "$project_dir/ElectronApp/preload-dot.js" "$stage_dir/preload-dot.js"
/bin/cp "$project_dir/ElectronApp/preload-panel.js" "$stage_dir/preload-panel.js"
/bin/cp "$project_dir/ElectronApp/preload-settings.js" "$stage_dir/preload-settings.js"
/bin/cp "$project_dir/ElectronApp/preload-notification.js" "$stage_dir/preload-notification.js"
/bin/cp "$project_dir/Resources/LegacyV11/dot.html" "$stage_dir/renderer/dot.html"
/bin/cp "$project_dir/Resources/LegacyV11/panel.html" "$stage_dir/renderer/panel.html"
/bin/cp "$project_dir/Resources/LegacyV11/settings.html" "$stage_dir/renderer/settings.html"
/bin/cp "$project_dir/Resources/LegacyV11/notification.html" "$stage_dir/renderer/notification.html"
/bin/cp "$dot_css" "$stage_dir/renderer/pet-status-dot.css"
/bin/cp "$panel_css" "$stage_dir/renderer/pet-panel.css"
/bin/cp "$project_dir/Resources/LegacyV11/settings.css" "$stage_dir/renderer/settings.css"
/bin/cp "$project_dir/Resources/LegacyV11/notification.css" "$stage_dir/renderer/notification.css"
/bin/cp "$project_dir/Resources/LegacyV11/app-icon.png" "$stage_dir/renderer/app-icon.png"
/usr/bin/env node "$script_dir/harden-renderer-pages.mjs" "$stage_dir/renderer"
/bin/cp "$app_icon" "$resources_dir/icon.icns"
/bin/mkdir -p "$resources_dir/licenses"
# Ship notices from the matching pristine Electron distribution, not from an
# unrelated installed application. A missing license is a build error.
electron_dist_dir="${template_app:h}"
for notice_file in LICENSE LICENSES.chromium.html; do
  [[ -s "$electron_dist_dir/$notice_file" ]] || {
    echo "Electron distribution notice missing: $notice_file" >&2
    exit 1
  }
  /bin/cp "$electron_dist_dir/$notice_file" "$resources_dir/licenses/$notice_file"
done
/bin/cp "$project_dir/THIRD_PARTY_NOTICES.md" "$resources_dir/licenses/"
if [[ -f "$project_dir/LICENSE" ]]; then
  /bin/cp "$project_dir/LICENSE" "$resources_dir/licenses/CodeX-Status-Reminder-LICENSE"
fi
/bin/mkdir -p "$resources_dir/TrayIcon"
/bin/cp "$tray_icon_dir/CodexCompanionTemplate.png" "$resources_dir/TrayIcon/"
/bin/cp "$tray_icon_dir/CodexCompanionTemplate@2x.png" "$resources_dir/TrayIcon/"
/bin/cp "$tray_icon_dir/CodexQuotaStarTemplate.png" "$resources_dir/TrayIcon/"
/bin/cp "$tray_icon_dir/CodexQuotaStarTemplate@2x.png" "$resources_dir/TrayIcon/"
/bin/mkdir -p "$resources_dir/Worker"
/bin/cp "$project_dir/ElectronApp/task-data-worker.js" "$resources_dir/Worker/"
/bin/cp "$project_dir/ElectronApp/codex-state.js" "$resources_dir/Worker/"
/bin/cp "$project_dir/ElectronApp/quota-data-worker.js" "$resources_dir/Worker/"
/bin/cp "$project_dir/ElectronApp/codex-app-server-client.js" "$resources_dir/Worker/"
/bin/cp "$project_dir/ElectronApp/codex-quota-provider.js" "$resources_dir/Worker/"

/bin/mkdir -p "$resources_dir/Recovery"
/usr/bin/xcrun swiftc \
  -O \
  -target "$swift_arch-apple-macos12.0" \
  "$recovery_source" \
  -o "$resources_dir/Recovery/CodexCompanionRecovery"

"$node_binary" "$asar_cli" pack "$stage_dir" "$resources_dir/app.asar"

asar_hash=$(
  ASAR_MODULE="$asar_module" ASAR_PATH="$resources_dir/app.asar" "$node_binary" --input-type=module - <<'NODE'
import crypto from "crypto";
const modulePath = process.env.ASAR_MODULE;
const archivePath = process.env.ASAR_PATH;
const { getRawHeader } = await import(`file://${modulePath}`);
const header = getRawHeader(archivePath).headerString;
process.stdout.write(crypto.createHash("sha256").update(header).digest("hex"));
NODE
)

/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName CodeX状态提醒" "$info_plist"
# Electron derives its helper location from CFBundleName. Keep this technical
# value aligned with the bundled helper apps; CFBundleDisplayName and the app
# bundle filename carry the user-facing Chinese product name.
/usr/libexec/PlistBuddy -c "Set :CFBundleName Codex Companion" "$info_plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.lindaozhi.codexstatusreminder" "$info_plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "$info_plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon.icns" "$info_plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.9.14" "$info_plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 65" "$info_plist"
if ! /usr/libexec/PlistBuddy \
  -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $asar_hash" \
  "$info_plist" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$info_plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :ElectronAsarIntegrity dict" "$info_plist"
  /usr/libexec/PlistBuddy \
    -c "Add :ElectronAsarIntegrity:Resources/app.asar dict" \
    "$info_plist"
  /usr/libexec/PlistBuddy \
    -c "Add :ElectronAsarIntegrity:Resources/app.asar:hash string $asar_hash" \
    "$info_plist"
fi
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSAudioCaptureUsageDescription" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSBluetoothAlwaysUsageDescription" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSBluetoothPeripheralUsageDescription" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSCameraUsageDescription" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSAppleEventsUsageDescription" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$info_plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion 12.0" "$info_plist"
# This is a menu-bar utility, not a Dock application. Declare the accessory
# identity in the bundle before AppKit starts so the Dock never registers a
# transient product icon during login, restart, or settings-window creation.
if ! /usr/libexec/PlistBuddy -c "Set :LSUIElement bool true" "$info_plist" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$info_plist"
fi

# iCloud-synced source trees can carry com.apple.provenance/FinderInfo onto
# copied Electron resources. Those metadata are not app resources and make
# codesign reject the bundle as a resource-fork payload. Clear them only from
# the generated bundle immediately before signing; source files stay intact.
/usr/bin/xattr -cr "$app_root" 2>/dev/null || true

/usr/bin/codesign --force --deep --sign - "$app_root"
# An ordinary ad-hoc signature synthesizes a designated requirement from the
# current cdhash, so every rebuild becomes a different macOS application
# identity. Give local development builds a stable, Codex Companion-only DR.
# Distribution packaging replaces this signature with Developer ID signing.
/usr/bin/codesign \
  --force \
  --sign - \
  --requirements "$development_requirement" \
  "$app_root"
/usr/bin/codesign --verify --deep --strict "$app_root"
echo "$app_root"

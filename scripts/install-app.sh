#!/bin/zsh
set -euo pipefail

# Retained only for explicitly requested local development migrations.
# Public users install the signed application by dragging it in Finder;
# a normal build/test must never replace their installed app or preferences.
if [[ "${CODEX_COMPANION_ALLOW_DEVELOPMENT_INSTALL:-0}" != "1" ]]; then
  echo "Development installer is disabled by default. Use Finder for normal installation." >&2
  echo "Only for a deliberate local migration: CODEX_COMPANION_ALLOW_DEVELOPMENT_INSTALL=1" >&2
  exit 2
fi

script_dir=${0:A:h}
project_dir=${script_dir:h}
product_app_name="CodeX状态提醒"
legacy_app_name="Codex Companion"
product_bundle_id="com.lindaozhi.codexstatusreminder"
legacy_bundle_ids=(
  "com.lindaozhi.codexcompanion.app"
  "com.lindaozhi.codexcompanion.desktop"
  "com.lindaozhi.codexcompanion"
)
# Allow a caller to place the signed build outside an iCloud-synced source
# tree. iCloud attaches provenance/Finder metadata to copied Electron files;
# using a local build output keeps codesign and installation portable while
# retaining the existing project-local default for normal checkouts.
source_app="${CODEX_COMPANION_APP_OUTPUT:-$project_dir/.build/products/$product_app_name.app}"
default_target_app="/Applications/$product_app_name.app"
target_app="${CODEX_COMPANION_INSTALL_PATH:-${1:-$default_target_app}}"
legacy_default_app="/Applications/$legacy_app_name.app"
app_support_dir="$HOME/Library/Application Support/codex-companion"
launch_services_register="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
current_arch=$(/usr/bin/uname -m)
macos_major=$(/usr/bin/sw_vers -productVersion | /usr/bin/awk -F. '{print $1}')

if [[ "$target_app" != /* || "$target_app" != *.app || ${#target_app} -lt 12 ]]; then
  echo "Install path must be an absolute .app path: $target_app" >&2
  exit 1
fi
if (( macos_major < 12 )); then
  echo "CodeX状态提醒 requires macOS 12 or later; current version is $(/usr/bin/sw_vers -productVersion)." >&2
  exit 1
fi

"$script_dir/build-app.sh" >/dev/null

source_executable=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$source_app/Contents/Info.plist")
source_arches=$(/usr/bin/lipo -archs "$source_app/Contents/MacOS/$source_executable")
if [[ " $source_arches " != *" $current_arch "* ]]; then
  echo "App architecture mismatch: Mac=$current_arch, app=$source_arches" >&2
  exit 1
fi

install_parent="${target_app:h}"
# Do not stage an .app bundle directly under /Applications. LaunchServices can
# observe even hidden `*.app` staging directories and retain them as separate
# applications, which later produces duplicate menu-bar records. Keep the
# whole transaction in one hidden directory whose children do not end in
# `.app`; the final move into the target path remains an atomic same-volume
# rename.
install_transaction_dir="$install_parent/.$product_app_name.installing.$$.transaction"
staged_app="$install_transaction_dir/payload"
backup_target_app="$install_transaction_dir/previous-product"
backup_legacy_app="$install_transaction_dir/previous-legacy"
failed_app="$install_transaction_dir/failed-product"
swap_active=false
legacy_app_to_migrate=""

is_owned_legacy_app() {
  local candidate="$1"
  local bundle_id
  local executable
  local legacy_bundle_id
  [[ -d "$candidate" ]] || return 1
  bundle_id=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$candidate/Contents/Info.plist" 2>/dev/null || true)
  executable=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$candidate/Contents/Info.plist" 2>/dev/null || true)
  [[ "$executable" == "Codex Companion" ]] || return 1
  [[ "$bundle_id" == "$product_bundle_id" ]] && return 0
  for legacy_bundle_id in "${legacy_bundle_ids[@]}"; do
    [[ "$bundle_id" == "$legacy_bundle_id" ]] && return 0
  done
  return 1
}

clear_legacy_status_item_preferences() {
  # These are the retired native status-host domains only. Clear their old
  # NSStatusItem visibility keys during an in-place upgrade so macOS 26 does
  # not associate the final application's Tray with a predecessor host. This
  # is ordinary app-preference migration: it never reads or writes Control
  # Center's private domain and it leaves the current Application Support
  # settings (quota, tasks, language and widget position) untouched.
  local legacy_domain
  local legacy_key
  local legacy_keys
  local legacy_domains=(
    "com.lindaozhi.codex-companion.statusitem"
    "com.lindaozhi.codex-companion.menu-bar"
    "com.lindaozhi.codex-companion.menu-bar.v2"
  )
  for legacy_domain in "${legacy_domains[@]}"; do
    legacy_keys=$(
      { defaults read "$legacy_domain" 2>/dev/null || true } \
        | /usr/bin/sed -n 's/^[[:space:]]*"\\(NSStatusItem Visible[^"=]*\\)".*/\\1/p'
    )
    for legacy_key in ${(f)legacy_keys}; do
      [[ -n "$legacy_key" ]] || continue
      defaults delete "$legacy_domain" "$legacy_key" 2>/dev/null || true
    done
  done
}

clear_legacy_menu_bar_diagnostics() {
  # Early prototypes wrote fixed diagnostic filenames into Application Support.
  # Production uses per-process `menu-bar-runtime-<pid>.json` files instead.
  # Clear only obsolete diagnostic artifacts, never the current runtime files
  # or user-facing settings, quota cache, CodeX connection, task state, or
  # desktop position.
  local artifact_name
  local artifact_path
  local legacy_artifacts=(
    "menu-bar-runtime.json"
    "main-menu-bar-runtime.json"
    "menu-bar-state.json"
    "menu-bar-command.json"
    "bundled-menu-diagnostic-runtime.json"
    "bundled-menu-open-runtime.json"
    "bundled-menu-v2-diagnostic-runtime.json"
    "embedded-menu-diagnostic-runtime.json"
    "native-menu-diagnostic-runtime.json"
    "native-menu-diagnostic-runtime2.json"
  )
  for artifact_name in "${legacy_artifacts[@]}"; do
    artifact_path="$app_support_dir/$artifact_name"
    [[ -f "$artifact_path" || -L "$artifact_path" ]] || continue
    /bin/rm -f "$artifact_path"
  done
  for artifact_path in "$app_support_dir"/menu-bar-runtime-v2-*.json.lock(N); do
    /bin/rm -f "$artifact_path"
  done
}

unregister_replaced_bundle() {
  local bundle_path="$1"
  local legacy_menu_executable="$bundle_path/Contents/Helpers/Codex Companion Menu Bar.app/Contents/MacOS/Codex Companion Menu Bar"
  local legacy_menu_host="$bundle_path/Contents/Helpers/Codex Companion Menu Bar.app"
  local recovery_helper="$bundle_path/Contents/Resources/Recovery/CodexCompanionRecovery"
  local target_executable

  # Stop the app-owned one-shot crash-recovery helper before replacing its
  # bundle. Otherwise an upgrade could race with a helper reopening the old
  # app path after its parent process exits.
  /usr/bin/pkill -f "^$recovery_helper( |$)" 2>/dev/null || true
  /usr/bin/pkill -f "^$legacy_menu_executable( |$)" 2>/dev/null || true
  target_executable=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$bundle_path/Contents/Info.plist" 2>/dev/null || true)
  if [[ -n "$target_executable" ]]; then
    /usr/bin/pkill -f "^$bundle_path/Contents/MacOS/$target_executable( |$)" 2>/dev/null || true
  fi
  if [[ -x "$launch_services_register" ]]; then
    if [[ -d "$legacy_menu_host" ]]; then
      "$launch_services_register" -u "$legacy_menu_host" >/dev/null 2>&1 || true
    fi
    "$launch_services_register" -u "$bundle_path" >/dev/null 2>&1 || true
  fi
}

cleanup_orphaned_legacy_staging_apps() {
  # Builds before the transaction-directory installer used hidden *.app
  # directories directly in /Applications. Remove only those exact old
  # temporary paths after confirming their Electron executable and one of this
  # product's known bundle identifiers. This is ordinary LaunchServices
  # cleanup, never a write to Control Center's private state.
  local app_name
  local artifact_kind
  local candidate
  for app_name in "$product_app_name" "$legacy_app_name"; do
    for artifact_kind in installing backup failed; do
      for candidate in "$install_parent"/."$app_name"."$artifact_kind".*.app(N); do
        [[ -d "$candidate" ]] || continue
        # An interrupted migration may rely on its only backup when no valid
        # target exists yet. Staging payloads are always safe to discard;
        # backups/failed copies are removed only once a valid target is in
        # place.
        if [[ "$artifact_kind" != "installing" ]] && ! is_owned_legacy_app "$target_app"; then
          continue
        fi
        is_owned_legacy_app "$candidate" || continue
        unregister_replaced_bundle "$candidate"
        /bin/rm -rf "$candidate"
      done
    done
  done
}

if [[ "$target_app" == "$default_target_app" ]] \
  && is_owned_legacy_app "$legacy_default_app"; then
  # Migrate the previous English-named bundle in place. The final bundle ID is
  # intentionally new so macOS 26 does not reuse the old, blocked status-item
  # registration; the shared Application Support directory preserves all
  # user-facing settings and CodeX data connection state.
  legacy_app_to_migrate="$legacy_default_app"
fi

rollback_install() {
  local exit_status=$?
  trap - EXIT
  set +e
  if (( exit_status != 0 )); then
    if [[ "$swap_active" == true ]]; then
      if [[ -d "$target_app" ]]; then /bin/mv "$target_app" "$failed_app"; fi
      if [[ -d "$backup_target_app" ]]; then /bin/mv "$backup_target_app" "$target_app"; fi
      if [[ -n "$legacy_app_to_migrate" && -d "$backup_legacy_app" ]]; then
        /bin/mv "$backup_legacy_app" "$legacy_app_to_migrate"
      fi
      if [[ -d "$failed_app" ]]; then /bin/rm -rf "$failed_app"; fi
      echo "Installation failed; the previous app was restored." >&2
    fi
  fi
  if [[ -d "$install_transaction_dir" ]]; then /bin/rm -rf "$install_transaction_dir"; fi
  exit "$exit_status"
}
trap rollback_install EXIT

/bin/mkdir -p "$install_parent"
cleanup_orphaned_legacy_staging_apps
/bin/mkdir "$install_transaction_dir"
/usr/bin/ditto "$source_app" "$staged_app"
/usr/bin/codesign --verify --deep --strict "$staged_app"

/usr/bin/pkill -x CodexCompanion 2>/dev/null || true
if [[ -d "$target_app" ]]; then
  unregister_replaced_bundle "$target_app"
fi
if [[ -n "$legacy_app_to_migrate" ]]; then
  unregister_replaced_bundle "$legacy_app_to_migrate"
fi
clear_legacy_status_item_preferences
clear_legacy_menu_bar_diagnostics
swap_active=true
if [[ -d "$target_app" ]]; then
  /bin/mv "$target_app" "$backup_target_app"
fi
if [[ -n "$legacy_app_to_migrate" ]]; then
  /bin/mv "$legacy_app_to_migrate" "$backup_legacy_app"
fi
/bin/mv "$staged_app" "$target_app"
/usr/bin/codesign --verify --deep --strict "$target_app"
# Finder/Launchpad may retain the previous icon for a bundle with the same
# identifier. Re-register the swapped-in bundle so the new CodeX状态提醒
# icon and path are picked up without requiring users to clear caches manually.
if [[ -x "$launch_services_register" ]]; then
  "$launch_services_register" -f "$target_app" >/dev/null 2>&1 || true
fi
/usr/bin/touch "$target_app"
swap_active=false
echo "$target_app"

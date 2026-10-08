#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
expected_version=$(
  /usr/bin/env node -p "require(process.argv[1]).version" \
    "$project_dir/ElectronApp/package.json"
)
expected_build=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
    "$project_dir/Resources/Info.plist"
)
generated_app="${CODEX_COMPANION_APP_PATH:-$project_dir/.build/products/CodeX状态提醒.app}"
distribution_check="${CODEX_COMPANION_DISTRIBUTION:-0}"

fail() {
  echo "RELEASE CHECK FAILED: $1" >&2
  exit 1
}

[[ -f "$project_dir/package-lock.json" ]] \
  || fail "package-lock.json is missing"
[[ ! -d "$project_dir/dist/Codex Companion.app" ]] \
  || fail "a visible duplicate app still exists under dist/"
[[ ! -d "$project_dir/dist/CodeX状态提醒.app" ]] \
  || fail "a visible duplicate app still exists under dist/"

/usr/bin/plutil -lint "$project_dir/Resources/Info.plist" >/dev/null
[[ -f "$project_dir/Resources/AppIcon/icon.icns" ]] \
  || fail "custom application icon is missing"
[[ -f "$project_dir/Resources/DevelopmentDesignatedRequirement.req" ]] \
  || fail "development designated requirement is missing"

source_icon_file=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" \
    "$project_dir/Resources/Info.plist"
)
[[ "$source_icon_file" == "icon.icns" ]] \
  || fail "source bundle icon is not Codex Companion icon.icns"
source_bundle_id=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
    "$project_dir/Resources/Info.plist"
)
[[ "$source_bundle_id" == "com.lindaozhi.codexstatusreminder" ]] \
  || fail "source app bundle identity is inconsistent"
source_display_name=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" \
    "$project_dir/Resources/Info.plist"
)
[[ "$source_display_name" == "CodeX状态提醒" ]] \
  || fail "source app display name is inconsistent"
source_bundle_name=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleName" \
    "$project_dir/Resources/Info.plist"
)
[[ "$source_bundle_name" == "Codex Companion" ]] \
  || fail "source app technical name is inconsistent"
source_ui_element=$(
  /usr/libexec/PlistBuddy -c "Print :LSUIElement" \
    "$project_dir/Resources/Info.plist"
)
[[ "$source_ui_element" == "true" ]] \
  || fail "source app must declare the menu-bar accessory lifecycle"

resource_version=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "$project_dir/Resources/Info.plist"
)
resource_build=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
    "$project_dir/Resources/Info.plist"
)
[[ "$resource_version" == "$expected_version" ]] \
  || fail "Resources/Info.plist version is inconsistent"
[[ "$resource_build" == "$expected_build" ]] \
  || fail "bundle build number is inconsistent"
/usr/bin/env rg -q "APP_VERSION = \"$expected_version\"" \
  "$project_dir/ElectronApp/main.js" \
  || fail "Electron APP_VERSION is inconsistent"
/usr/bin/env rg -q "static let current = \"$expected_version\"" \
  "$project_dir/Sources/CodexCompanion/Models.swift" \
  || fail "Swift compatibility version is inconsistent"
/usr/bin/env rg -q "CFBundleShortVersionString $expected_version" \
  "$project_dir/scripts/build-electron-app.sh" \
  || fail "build script version is inconsistent"
/usr/bin/env node -e \
  "const p=require(process.argv[1]);const major=Number(p.devDependencies.electron.split('.')[0]);if(major<43)process.exit(1)" \
  "$project_dir/package.json" \
  || fail "Electron must stay on a supported release line"

if /usr/bin/env rg -n --glob "!check-release-readiness.sh" "/Users/[^/]+/" \
  "$project_dir/ElectronApp" \
  "$project_dir/Resources" \
  "$project_dir/scripts" \
  >/dev/null; then
  fail "runtime source contains a developer-specific absolute home path"
fi

/usr/bin/env node "$project_dir/scripts/audit-public-source.mjs" \
  || fail "public source audit failed"

if [[ -d "$generated_app" ]]; then
  generated_version=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
      "$generated_app/Contents/Info.plist"
  )
  generated_build=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
      "$generated_app/Contents/Info.plist"
  )
  [[ "$generated_version" == "$expected_version" && "$generated_build" == "$expected_build" ]] \
    || fail "generated app version is inconsistent"
  generated_icon_file=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" \
      "$generated_app/Contents/Info.plist"
  )
  [[ "$generated_icon_file" == "icon.icns" ]] \
    || fail "generated app still points at Electron icon"
  generated_bundle_id=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
      "$generated_app/Contents/Info.plist"
  )
  [[ "$generated_bundle_id" == "com.lindaozhi.codexstatusreminder" ]] \
    || fail "generated app bundle identity is inconsistent"
  generated_display_name=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" \
      "$generated_app/Contents/Info.plist"
  )
  [[ "$generated_display_name" == "CodeX状态提醒" ]] \
    || fail "generated app display name is inconsistent"
  generated_bundle_name=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleName" \
      "$generated_app/Contents/Info.plist"
  )
  [[ "$generated_bundle_name" == "Codex Companion" ]] \
    || fail "generated app technical name is inconsistent"
  [[ -d "$generated_app/Contents/Frameworks/$generated_bundle_name Helper.app" ]] \
    || fail "generated app helper name is incompatible with CFBundleName"
  generated_ui_element=$(
    /usr/libexec/PlistBuddy -c "Print :LSUIElement" \
      "$generated_app/Contents/Info.plist"
  )
  [[ "$generated_ui_element" == "true" ]] \
    || fail "generated app must declare the menu-bar accessory lifecycle"
  [[ -f "$generated_app/Contents/Resources/icon.icns" ]] \
    || fail "generated app custom icon resource is missing"
  [[ -s "$generated_app/Contents/Resources/licenses/LICENSE" \
    && -s "$generated_app/Contents/Resources/licenses/LICENSES.chromium.html" ]] \
    || fail "generated app does not preserve Electron / Chromium licenses"
  [[ -x "$generated_app/Contents/Resources/Recovery/CodexCompanionRecovery" ]] \
    || fail "generated app background recovery helper is missing"
  [[ ! -d "$generated_app/Contents/Helpers/Codex Companion Menu Bar.app" ]] \
    || fail "generated app still contains the deprecated nested menu host"
  helper_plists=(
    "$generated_app"/Contents/Frameworks/Codex\ Companion\ Helper*.app/Contents/Info.plist(N)
  )
  (( ${#helper_plists} == 4 )) \
    || fail "generated app does not contain the expected four Electron helpers"
  for helper_plist in "${helper_plists[@]}"; do
    helper_bundle_id=$(
      /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$helper_plist"
    )
    [[ "$helper_bundle_id" == com.lindaozhi.codexstatusreminder.helper* ]] \
      || fail "generated helper still uses a foreign or legacy bundle identity"
  done
  /usr/bin/codesign --verify --deep --strict "$generated_app"
  if [[ "$distribution_check" == "1" ]]; then
    /usr/bin/env node "$project_dir/scripts/check-publication.mjs" binary \
      || fail "binary publication has not been approved"
    signature_details=$(
      /usr/bin/codesign -dv --verbose=4 "$generated_app" 2>&1
    )
    print -r -- "$signature_details" \
      | /usr/bin/env rg -q "^Authority=Developer ID Application:" \
      || fail "distribution app is not signed with Developer ID Application"
    print -r -- "$signature_details" \
      | /usr/bin/env rg -q "^TeamIdentifier=[A-Z0-9]+$" \
      || fail "distribution app has no signing team identifier"
    print -r -- "$signature_details" \
      | /usr/bin/env rg -q "flags=.*runtime" \
      || fail "distribution app does not enable hardened runtime"
    /usr/bin/xcrun stapler validate "$generated_app" >/dev/null \
      || fail "distribution app has no valid notarization ticket"
    /usr/sbin/spctl -a -t exec "$generated_app" >/dev/null \
      || fail "Gatekeeper rejects the distribution app"
  else
    generated_requirement=$(
      /usr/bin/codesign -d -r- "$generated_app" 2>&1 \
        | /usr/bin/sed -n 's/^designated => //p'
    )
    [[ "$generated_requirement" == 'identifier "com.lindaozhi.codexstatusreminder"' ]] \
      || fail "development app identity changes between rebuilds"
  fi
fi

echo "PASS release-readiness version=$expected_version build=$expected_build distribution=$distribution_check"

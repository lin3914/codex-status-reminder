#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
output_dir="${CODEX_COMPANION_RELEASE_OUTPUT:-$project_dir/.build/releases}"
staging_dir="${CODEX_COMPANION_RELEASE_STAGING:-$project_dir/.build/release-staging}"
release_mode="${CODEX_COMPANION_RELEASE_MODE:-distribution}"
version=$(
  /usr/bin/env node -p "require(process.argv[1]).version" \
    "$project_dir/ElectronApp/package.json"
)
build=$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
    "$project_dir/Resources/Info.plist"
)

case "$release_mode" in
  distribution|development)
    ;;
  *)
    echo "CODEX_COMPANION_RELEASE_MODE must be distribution or development" >&2
    exit 2
    ;;
esac

if [[ "$release_mode" == "distribution" ]]; then
  /usr/bin/env node "$script_dir/check-publication.mjs" binary
  /usr/bin/env node "$script_dir/check-electron-support.mjs"
  if [[ -z "${CODEX_COMPANION_SIGN_IDENTITY:-}" ]]; then
    echo "Distribution packaging requires CODEX_COMPANION_SIGN_IDENTITY." >&2
    exit 2
  fi
  if [[ -z "${CODEX_COMPANION_NOTARY_PROFILE:-}" ]]; then
    echo "Distribution packaging requires CODEX_COMPANION_NOTARY_PROFILE." >&2
    exit 2
  fi
fi

/usr/bin/env node "$script_dir/validate-build-paths.mjs" \
  "$project_dir" "$staging_dir" "$output_dir"

/bin/rm -rf "$staging_dir"
/bin/mkdir -p "$staging_dir" "$output_dir"

archives=()
target_arches=(arm64 x86_64)
if [[ -n "${CODEX_COMPANION_RELEASE_ARCHS:-}" ]]; then
  target_arches=(${=CODEX_COMPANION_RELEASE_ARCHS})
fi
for target_arch in "${target_arches[@]}"; do
  [[ "$target_arch" == "arm64" || "$target_arch" == "x86_64" ]] || {
    echo "Unsupported release architecture: $target_arch" >&2
    exit 2
  }
done
for target_arch in "${target_arches[@]}"; do
  app_path="$staging_dir/$target_arch/CodeX状态提醒.app"
  /bin/mkdir -p "${app_path:h}"
  CODEX_COMPANION_TARGET_ARCH="$target_arch" \
    CODEX_COMPANION_APP_OUTPUT="$app_path" \
    "$script_dir/build-app.sh" >/dev/null

  executable=$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" \
      "$app_path/Contents/Info.plist"
  )
  expected_arch="$target_arch"
  runtime_arches=$(/usr/bin/lipo -archs "$app_path/Contents/MacOS/$executable")
  [[ " $runtime_arches " == *" $expected_arch "* ]] || {
    echo "Built runtime does not contain $expected_arch: $runtime_arches" >&2
    exit 1
  }

  if [[ "$release_mode" == "distribution" ]]; then
    /usr/bin/env node "$script_dir/sign-macos-app.mjs" "$app_path"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
    /usr/bin/env node "$script_dir/notarize-macos-app.mjs" "$app_path"
    /usr/bin/xcrun stapler staple "$app_path"
    /usr/bin/xcrun stapler validate "$app_path"
    /usr/sbin/spctl -a -vvv -t exec "$app_path"
  else
    /usr/bin/codesign --verify --deep --strict "$app_path"
  fi

  archive="$output_dir/Codex-Companion-$version-$build-macos-$target_arch.zip"
  /bin/rm -f "$archive"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive"
  archives+=("$archive")
done

checksum_file="$output_dir/SHA256SUMS"
(
  cd "$output_dir"
  /usr/bin/shasum -a 256 "${archives[@]:t}"
) > "$checksum_file"

echo "Created:"
for archive in "${archives[@]}"; do
  echo "  $archive"
done
echo "  $checksum_file"

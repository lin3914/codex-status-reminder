#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
project_dir=${script_dir:h}
preview_binary="$project_dir/.build/codex-companion-preview"
preview_image="$project_dir/dist/codex-companion-preview.png"

/bin/mkdir -p "$project_dir/.build" "$project_dir/dist"
/usr/bin/swiftc \
  -parse-as-library \
  "$project_dir/Sources/CodexCompanion/Models.swift" \
  "$project_dir/Sources/CodexCompanion/Views.swift" \
  "$project_dir/Tests/Preview/PreviewRenderer.swift" \
  -o "$preview_binary"

"$preview_binary" "$preview_image"

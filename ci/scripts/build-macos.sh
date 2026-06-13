#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

read_app_version
export SKIP_APT_INSTALL=1
setup_build_env
clean_macos_bundle_output
ensure_rust
setup_rust_cargo_npm_mirrors
rustup target add aarch64-apple-darwin
print_tool_versions
npm_ci_install

npm run tauri:build:mac:arm

DMG_DIR="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
test -n "$(ls -A "$DMG_DIR" 2>/dev/null)" || {
  echo "ERROR: macOS arm64 DMG 产物未生成"
  ls -R src-tauri/target/aarch64-apple-darwin/release/bundle 2>/dev/null || true
  exit 1
}

DMG_SRC="$(find "$DMG_DIR" -maxdepth 1 -name '*.dmg' -print -quit)"
test -n "$DMG_SRC" || {
  echo "ERROR: DMG 文件未找到"
  ls -al "$DMG_DIR"
  exit 1
}

DIST_DIR="dist/macos"
mkdir -p "$DIST_DIR"
rm -rf "${DIST_DIR:?}"/*

echo "开始重命名"
mv "$DMG_SRC" "$DIST_DIR/MDEditor-${VERSION}-macos-arm64.dmg"

echo "重命名结果"
ls -al "$DIST_DIR"

clean_macos_bundle_output
save_target_cache

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

read_app_version
setup_build_env
clean_windows_bundle_output
ensure_apt_packages \
  curl ca-certificates pkg-config build-essential wget file libssl-dev \
  nsis lld clang llvm
ensure_rust
setup_rust_cargo_npm_mirrors
rustup target add x86_64-pc-windows-msvc
command -v cargo-xwin >/dev/null 2>&1 || cargo install cargo-xwin --locked
print_tool_versions
npm_ci_install

npm run tauri:build:windows:cross

NSIS_DIR="src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
test -n "$(ls -A "$NSIS_DIR" 2>/dev/null)" || {
  echo "ERROR: NSIS 产物未生成"
  exit 1
}

SETUP_EXE="$(find "$NSIS_DIR" -maxdepth 1 -name '*-setup.exe' -print -quit)"
test -n "$SETUP_EXE" || {
  echo "ERROR: NSIS setup.exe 未找到"
  ls -al "$NSIS_DIR"
  exit 1
}

DIST_DIR="dist/windows"
mkdir -p "$DIST_DIR"
rm -rf "${DIST_DIR:?}"/*

echo "开始重命名"
mv "$SETUP_EXE" "$DIST_DIR/MDEditor-${VERSION}-windows-x64-setup.exe"
cp "src-tauri/target/x86_64-pc-windows-msvc/release/md-editor.exe" \
  "$DIST_DIR/MDEditor-${VERSION}-windows-x64-portable.exe"

echo "重命名结果"
ls -al "$DIST_DIR"

# 避免旧安装包再次进入 target 缓存
clean_windows_bundle_output
save_target_cache

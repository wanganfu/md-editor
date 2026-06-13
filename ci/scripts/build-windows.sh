#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

read_app_version
setup_build_env
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

cp "src-tauri/target/x86_64-pc-windows-msvc/release/md-editor.exe" "$NSIS_DIR/"
ls -al "src-tauri/target/x86_64-pc-windows-msvc/release"
ls -al "$NSIS_DIR"
save_target_cache

SETUP_EXE="$(find "$NSIS_DIR" -maxdepth 1 -name '*-setup.exe' -print -quit)"
test -n "$SETUP_EXE" || {
  echo "ERROR: NSIS setup.exe 未找到"
  ls -al "$NSIS_DIR"
  exit 1
}
mv "$SETUP_EXE" "$NSIS_DIR/MDEditor-${VERSION}-windows-x64-setup.exe"
mv "$NSIS_DIR/md-editor.exe" "$NSIS_DIR/MDEditor-${VERSION}-windows-x64-portable.exe"

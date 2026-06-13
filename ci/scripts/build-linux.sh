#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

read_app_version
setup_build_env
clean_linux_bundle_output
ensure_apt_packages \
  curl ca-certificates pkg-config build-essential wget file libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm
ensure_rust
setup_rust_cargo_npm_mirrors
print_tool_versions
npm_ci_install

npm run tauri:build:linux:deb-rpm

DEB_SRC="$(find src-tauri/target/release/bundle/deb -maxdepth 1 -name '*.deb' -print -quit)"
RPM_SRC="$(find src-tauri/target/release/bundle/rpm -maxdepth 1 -name '*.rpm' -print -quit)"
test -n "$DEB_SRC" && test -n "$RPM_SRC" || {
  echo "ERROR: Linux deb/rpm 产物未生成"
  ls -R src-tauri/target/release/bundle
  exit 1
}

DIST_DIR="dist/linux"
mkdir -p "$DIST_DIR"
rm -rf "${DIST_DIR:?}"/*

echo "开始重命名"
mv "$DEB_SRC" "$DIST_DIR/MDEditor-${VERSION}-linux-amd64.deb"
mv "$RPM_SRC" "$DIST_DIR/MDEditor-${VERSION}-linux-amd64.rpm"

echo "重命名结果"
ls -al "$DIST_DIR"

clean_linux_bundle_output
save_target_cache

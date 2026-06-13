#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

setup_build_env
ensure_apt_packages \
  curl ca-certificates pkg-config build-essential wget file libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm
ensure_rust
setup_rust_cargo_npm_mirrors
print_tool_versions
npm_ci_install

npm run tauri:build:linux:deb-rpm

mkdir -p dist/linux
cp src-tauri/target/release/bundle/deb/*.deb dist/linux/ 2>/dev/null || true
cp src-tauri/target/release/bundle/rpm/*.rpm dist/linux/ 2>/dev/null || true

ls dist/linux/*.deb dist/linux/*.rpm >/dev/null 2>&1 || {
  echo "ERROR: Linux deb/rpm 产物未生成"
  ls -R src-tauri/target/release/bundle
  exit 1
}

ls -al dist/linux
save_target_cache

mv dist/linux/*.deb "dist/linux/MDEditor-${VERSION}-linux-amd64.deb"
mv dist/linux/*.rpm "dist/linux/MDEditor-${VERSION}-linux-amd64.rpm"

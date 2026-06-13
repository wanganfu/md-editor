#!/usr/bin/env bash
# Drone CI 公共构建逻辑（Windows 交叉编译 / Linux 原生打包共用）
set -euo pipefail

CACHE_ROOT="${CACHE_ROOT:-/cache}"

setup_build_env() {
  mkdir -p "$CACHE_ROOT/cargo" "$CACHE_ROOT/rustup" "$CACHE_ROOT/npm" "$CACHE_ROOT/target" "$CACHE_ROOT/xdg-cache"
  export PATH="$CACHE_ROOT/cargo/bin:$PATH"
  export CARGO_HOME="$CACHE_ROOT/cargo"
  export RUSTUP_HOME="$CACHE_ROOT/rustup"
  export NPM_CONFIG_CACHE="$CACHE_ROOT/npm"
  export XDG_CACHE_HOME="$CACHE_ROOT/xdg-cache"
  restore_target_cache
}

restore_target_cache() {
  if [ -d "$CACHE_ROOT/target" ] && [ -n "$(ls -A "$CACHE_ROOT/target" 2>/dev/null)" ]; then
    mkdir -p src-tauri/target
    cp -a "$CACHE_ROOT/target/." src-tauri/target/
  fi
}

save_target_cache() {
  mkdir -p "$CACHE_ROOT/target"
  cp -a src-tauri/target/. "$CACHE_ROOT/target/"
}

setup_apt_tsinghua_mirror() {
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources
    sed -i 's|security.debian.org/debian-security|mirrors.tuna.tsinghua.edu.cn/debian-security|g' /etc/apt/sources.list.d/debian.sources
  fi
}

ensure_apt_packages() {
  if [ "${SKIP_APT_INSTALL:-0}" = "1" ]; then
    return 0
  fi
  setup_apt_tsinghua_mirror
  apt-get update
  # shellcheck disable=SC2068
  apt-get install -y --no-install-recommends "$@"
}

ensure_rust() {
  if command -v rustc >/dev/null 2>&1; then
    return 0
  fi
  export RUSTUP_DIST_SERVER="${RUSTUP_DIST_SERVER:-https://mirrors.ustc.edu.cn/rust-static}"
  export RUSTUP_UPDATE_ROOT="${RUSTUP_UPDATE_ROOT:-https://mirrors.ustc.edu.cn/rust-static/rustup}"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  export PATH="$CACHE_ROOT/cargo/bin:$PATH"
}

setup_rust_cargo_npm_mirrors() {
  cat > "$CARGO_HOME/config.toml" <<'EOF'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
retry = 5
EOF
  npm config set registry https://registry.npmmirror.com
}

npm_ci_install() {
  npm install --prefer-offline --no-audit --fund=false
}

print_tool_versions() {
  node --version
  npm --version
  rustc --version
}

read_app_version() {
  VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
  export VERSION
}

#!/usr/bin/env bash
# Builds the Windows release from Linux: the player (for the Microsoft Store package, made by
# build-msix.ps1) and the server, bundled with its own Node.js, sharp and ffmpeg and run by
# hyperplayer-service.exe as a Windows service, for its install script:
# release/hyperplayer-<version>-windows-x64-server.zip and release/install-server.ps1.
#
#   packaging/windows/build.sh [stage|package]
#
# Both steps by default. Releases sign in between (.github/workflows/release.yml): `stage`
# builds the programs into release/windows, `package` packs the server.
#
# Needs: clang, lld and llvm (cross-compiling; cargo-xwin fetches Microsoft's headers and
# libraries), zip, unzip, and once per user:
#   rustup target add x86_64-pc-windows-msvc && cargo install --locked cargo-xwin
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$HOME/.cargo/bin:$PATH"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' apps/client/Cargo.toml | head -1)
NODE_VERSION=$(node -p 'process.versions.node')
# FFmpeg's stable series, static LGPL build (https://github.com/BtbN/FFmpeg-Builds).
FFMPEG_ZIP=ffmpeg-n8.1-latest-win64-lgpl-8.1.zip
CACHE=$ROOT/release/cache
STAGE=$ROOT/release/windows
STEP=${1:-all}
[[ "$STEP" == @(all|stage|package) ]] || {
  echo "Usage: $0 [stage|package]" >&2
  exit 1
}

fetch() { # url file: downloads into the cache once
  [[ -s "$CACHE/$2" ]] && return
  curl -fL --retry 3 -o "$CACHE/$2.part" "$1"
  mv "$CACHE/$2.part" "$CACHE/$2"
}

stage() {
  mkdir -p "$CACHE"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/server"

  echo "==> Player and service"
  cargo xwin build --release --target x86_64-pc-windows-msvc -p hyperplayer -p hyperplayer-service
  BIN=target/x86_64-pc-windows-msvc/release
  cp "$BIN/hyperplayer.exe" "$STAGE/"
  cp "$BIN/hyperplayer-service.exe" "$STAGE/server/"

  echo "==> Server"
  vp run @hyperplayer/schemas#generate
  (cd apps/server && vp pack)
  (cd apps/web && vp build)
  cp -a apps/server/dist "$STAGE/server/dist"
  # The web player, served at / (the server finds it beside dist/).
  cp -a apps/web/dist "$STAGE/server/web"
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" "node-v$NODE_VERSION-win-x64.zip"
  unzip -q -j -o "$CACHE/node-v$NODE_VERSION-win-x64.zip" "node-v$NODE_VERSION-win-x64/node.exe" -d "$STAGE/server"
  fetch "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$FFMPEG_ZIP" "$FFMPEG_ZIP"
  unzip -q -j -o "$CACHE/$FFMPEG_ZIP" "*/bin/ffmpeg.exe" -d "$STAGE/server"
  SHARP=$(node -p 'require("./apps/server/node_modules/sharp/package.json").version')
  cat >"$STAGE/server/package.json" <<EOF
{ "name": "hyperplayer-server", "version": "$VERSION", "private": true, "type": "module",
  "dependencies": { "sharp": "$SHARP" } }
EOF
  (cd "$STAGE/server" && npm install --omit=dev --no-package-lock --no-audit --no-fund --os=win32 --cpu=x64 --loglevel=error)
  cp packaging/windows/server-status.mjs "$STAGE/server/"
}

package() {
  echo "==> Server for install-server.ps1"
  ZIP=$ROOT/release/hyperplayer-$VERSION-windows-x64-server.zip
  rm -f "$ZIP"
  (cd "$STAGE/server" && zip -qr "$ZIP" .)
  zip -qj "$ZIP" packaging/windows/uninstall-server.ps1
  sed "s/@VERSION@/$VERSION/" packaging/windows/install-server.ps1 >"$ROOT/release/install-server.ps1"
  echo "==> $ZIP ($(stat -c %s "$ZIP" | numfmt --to=iec))"
}

[[ "$STEP" == package ]] || stage
[[ "$STEP" == stage ]] || package

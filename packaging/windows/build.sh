#!/usr/bin/env bash
# Builds the Windows installer from Linux: release/hyperplayer-<version>-windows-x64-setup.exe,
# with the player and the server (bundled with its own Node.js, sharp and ffmpeg, run by
# hyperplayer-service.exe as a Windows service).
#
# Needs: clang, lld and llvm (cross-compiling; cargo-xwin fetches Microsoft's headers and
# libraries), nsis, unzip, and once per user:
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
mkdir -p "$CACHE"
rm -rf "$STAGE"
mkdir -p "$STAGE/server"

fetch() { # url file: downloads into the cache once
  [[ -s "$CACHE/$2" ]] && return
  curl -fL --retry 3 -o "$CACHE/$2.part" "$1"
  mv "$CACHE/$2.part" "$CACHE/$2"
}

echo "==> Player and service"
cargo xwin build --release --target x86_64-pc-windows-msvc -p hyperplayer -p hyperplayer-service
BIN=target/x86_64-pc-windows-msvc/release
cp "$BIN/hyperplayer.exe" "$STAGE/"
cp "$BIN/hyperplayer-service.exe" "$STAGE/server/"

echo "==> Server"
vp run @hyperplayer/schemas#generate
(cd apps/server && vp pack)
cp -a apps/server/dist "$STAGE/server/dist"
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

echo "==> Installer"
OUT=$ROOT/release/hyperplayer-$VERSION-windows-x64-setup.exe
# Run from packaging/windows: the script's paths (the icon) are relative to it.
(cd packaging/windows && makensis -V2 -DVERSION="$VERSION" -DFILEVERSION="${VERSION%%-*}.0" \
  -DSTAGE="$STAGE" -DOUTFILE="$OUT" hyperplayer.nsi)
echo "==> $OUT ($(stat -c %s "$OUT" | numfmt --to=iec))"

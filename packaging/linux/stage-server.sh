#!/usr/bin/env bash
# Stages the bundled server for Linux x64 into <dir>: dist/ (the server, packed), Node.js
# and sharp. The same bundle is the systemd/Docker server and the player's library engine.
# With --ffmpeg, also a static ffmpeg (for the Flatpak, which has no system one).
#
#   packaging/linux/stage-server.sh <dir> [--ffmpeg]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$HOME/.cargo/bin:$PATH"
DEST=${1:?usage: $0 <dir> [--ffmpeg]}
WITH_FFMPEG=${2:-}
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' apps/client/Cargo.toml | head -1)
NODE_VERSION=$(node -p 'process.versions.node')
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' || {
  echo "Node.js >= 22.18 is needed to build the bundle" >&2
  exit 1
}
# FFmpeg's stable series, static LGPL build (https://github.com/BtbN/FFmpeg-Builds).
FFMPEG_TAR=ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz
CACHE=$ROOT/release/cache
mkdir -p "$CACHE"

fetch() { # url file: downloads into the cache once
  [[ -s "$CACHE/$2" ]] && return
  curl -fL --retry 3 -o "$CACHE/$2.part" "$1"
  mv "$CACHE/$2.part" "$CACHE/$2"
}

vp run @hyperplayer/schemas#generate
(cd apps/server && vp pack)
(cd apps/web && vp build)
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a apps/server/dist "$DEST/dist"
# The web player, served at / (the server finds it beside dist/).
cp -a apps/web/dist "$DEST/web"
# Node.js from nodejs.org (built for old glibc versions, so it runs on most systems and
# in the Flatpak's runtime), the version this build uses.
NODE_TAR=node-v$NODE_VERSION-linux-x64.tar.xz
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR" "$NODE_TAR"
tar -xJf "$CACHE/$NODE_TAR" -C "$DEST" --strip-components=2 "node-v$NODE_VERSION-linux-x64/bin/node"
SHARP=$(node -p 'require("./apps/server/node_modules/sharp/package.json").version')
cat >"$DEST/package.json" <<JSON
{ "name": "hyperplayer-server", "version": "$VERSION", "private": true, "type": "module",
  "dependencies": { "sharp": "$SHARP" } }
JSON
(cd "$DEST" && npm install --omit=dev --no-package-lock --no-audit --no-fund --os=linux --cpu=x64 --libc=glibc --loglevel=error)

if [[ "$WITH_FFMPEG" == --ffmpeg ]]; then
  fetch "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$FFMPEG_TAR" "$FFMPEG_TAR"
  tar -xJf "$CACHE/$FFMPEG_TAR" -C "$DEST" --strip-components=2 --wildcards "*/bin/ffmpeg"
fi

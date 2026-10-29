#!/usr/bin/env bash
# Builds the macOS release on a Mac, for its own architecture (Apple Silicon or Intel):
# release/hyperplayer-<version>-macos-<arm64|x64>.dmg, with HyperPlayer.app.
#
#   packaging/macos/build.sh
#
# Needs Xcode's command line tools and Rust. The app is signed ad hoc only (no Developer
# ID yet): macOS asks to allow it once, in System Settings → Privacy & Security.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$HOME/.cargo/bin:$PATH"

VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' apps/client/Cargo.toml | head -1)
SERVER_VERSION=$(sed -n 's/^export const SERVER_VERSION = "\(.*\)";/\1/p' apps/server/src/app.ts)
[[ "$VERSION" == "$SERVER_VERSION" ]] || {
  echo "Client ($VERSION) and server ($SERVER_VERSION) versions differ" >&2
  exit 1
}
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *)
    echo "Unknown architecture $(uname -m)" >&2
    exit 1
    ;;
esac
# The oldest macOS the release runs on (Big Sur, the first for Apple Silicon).
export MACOSX_DEPLOYMENT_TARGET=11.0
NAME=hyperplayer-$VERSION-macos-$ARCH
OUT=$ROOT/release
STAGE=$OUT/macos
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> Player"
vp run @hyperplayer/schemas#generate
cargo build --release -p hyperplayer
APP=$STAGE/HyperPlayer.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
install -m 755 target/release/hyperplayer "$APP/Contents/MacOS/hyperplayer"

# The icon, from the PNGs in every size macOS asks for (each also at double density).
ICONSET=$STAGE/HyperPlayer.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  cp "apps/client/icons/hyperplayer-$size.png" "$ICONSET/icon_${size}x${size}.png"
  cp "apps/client/icons/hyperplayer-$((size * 2)).png" "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns -o "$APP/Contents/Resources/HyperPlayer.icns" "$ICONSET"
rm -rf "$ICONSET"

# macOS wants a version of plain numbers here: the pre-release suffix goes.
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>io.ansaloni.HyperPlayer</string>
  <key>CFBundleName</key><string>HyperPlayer</string>
  <key>CFBundleDisplayName</key><string>HyperPlayer</string>
  <key>CFBundleExecutable</key><string>hyperplayer</string>
  <key>CFBundleIconFile</key><string>HyperPlayer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION%%-*}</string>
  <key>CFBundleVersion</key><string>${VERSION%%-*}</string>
  <key>LSMinimumSystemVersion</key><string>$MACOSX_DEPLOYMENT_TARGET</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Enrico Ansaloni, GPL-3.0-or-later</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>HyperPlayer connects to your HyperPlayer server, which may be on your local network.</string>
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - "$APP"

echo "==> Disk image"
DMG=$STAGE/dmg
mkdir -p "$DMG"
mv "$APP" "$DMG/"
ln -s /Applications "$DMG/Applications"
rm -f "$OUT/$NAME.dmg"
# hdiutil sometimes fails on GitHub's runners ("Resource busy"): try again.
for attempt in 1 2 3 4 5; do
  hdiutil create -volname "HyperPlayer $VERSION" -srcfolder "$DMG" -format UDZO "$OUT/$NAME.dmg" && break
  ((attempt < 5)) || exit 1
  echo "hdiutil failed, trying again in 10 seconds" >&2
  rm -f "$OUT/$NAME.dmg"
  sleep 10
done
echo "==> $OUT/$NAME.dmg ($(du -h "$OUT/$NAME.dmg" | cut -f1))"

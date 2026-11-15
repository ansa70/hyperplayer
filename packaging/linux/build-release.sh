#!/usr/bin/env bash
# Builds the Linux release bundle: release/hyperplayer-<version>-linux-x64.tar.gz, with
# the installer, the bundled server (with its Node.js and sharp), the Docker build
# files, the systemd units and the player's .deb.
#
#   packaging/linux/build-release.sh
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
[[ "$(uname -m)" == x86_64 ]] || {
  echo "Builds the x64 bundle; run it on an x86_64 machine" >&2
  exit 1
}
NAME=hyperplayer-$VERSION-linux-x64
OUT=$ROOT/release
STAGE=$OUT/$NAME
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> Server"
packaging/linux/stage-server.sh "$STAGE/server"

echo "==> Player"
cargo build --release -p hyperplayer
DEB=$OUT/deb
rm -rf "$DEB"
mkdir -p "$DEB/DEBIAN" "$DEB/usr/bin" "$DEB/usr/share/applications" "$DEB/usr/share/icons/hicolor/scalable/apps"
install -m 755 target/release/hyperplayer "$DEB/usr/bin/hyperplayer"
strip "$DEB/usr/bin/hyperplayer"
# The player's library engine (the server's code, for the music on this computer): the
# player looks for it in ../lib/hyperplayer/server.
mkdir -p "$DEB/usr/lib/hyperplayer"
cp -a "$STAGE/server" "$DEB/usr/lib/hyperplayer/server"
install -m 644 packaging/linux/io.ansaloni.HyperPlayer.desktop "$DEB/usr/share/applications/"
install -m 644 apps/client/icons/hyperplayer.svg "$DEB/usr/share/icons/hicolor/scalable/apps/io.ansaloni.HyperPlayer.svg"
for size in 16 32 48 64 128 256 512; do
  mkdir -p "$DEB/usr/share/icons/hicolor/${size}x${size}/apps"
  install -m 644 "apps/client/icons/hyperplayer-$size.png" "$DEB/usr/share/icons/hicolor/${size}x${size}/apps/io.ansaloni.HyperPlayer.png"
done
# Libraries the binary links to, as package dependencies (dpkg-shlibdeps wants a debian/control).
SHLIBS=$(
  tmp=$(mktemp -d)
  mkdir -p "$tmp/debian"
  printf 'Source: hyperplayer\n\nPackage: hyperplayer\nArchitecture: amd64\n' >"$tmp/debian/control"
  cd "$tmp" && dpkg-shlibdeps -O "$DEB/usr/bin/hyperplayer" | sed -n 's/^shlibs:Depends=//p'
  rm -rf "$tmp"
)
[[ -n "$SHLIBS" ]] || {
  echo "dpkg-shlibdeps found no dependencies" >&2
  exit 1
}
cat >"$DEB/DEBIAN/control" <<EOF
Package: hyperplayer
Version: ${VERSION/-/\~}
Architecture: amd64
Maintainer: Enrico Ansaloni <enrico.ansaloni@gmail.com>
Depends: $SHLIBS, libxkbcommon0, libwayland-client0 | libx11-6, libegl1 | libgl1
Recommends: ffmpeg
Section: sound
Priority: optional
Description: HyperPlayer music player
 Plays the music on this computer, or on a HyperPlayer server: browse the
 library, stream in the best quality the connection sustains, lyrics, history
 and scrobbling. ffmpeg draws the tracks' waveforms and plays formats the
 player can't decode itself.
EOF
mkdir -p "$STAGE/player"
fakeroot dpkg-deb --build -Zxz "$DEB" "$STAGE/player/hyperplayer_${VERSION/-/\~}_amd64.deb" >/dev/null
rm -rf "$DEB"

echo "==> Player (Flatpak)"
if command -v flatpak-builder >/dev/null || flatpak info org.flatpak.Builder >/dev/null 2>&1; then
  packaging/flatpak/build.sh
  cp "$OUT/hyperplayer-$VERSION-x86_64.flatpak" "$STAGE/player/"
else
  echo "Skipped: no flatpak-builder (see packaging/flatpak/build.sh)" >&2
fi

echo "==> Installer"
install -m 755 packaging/linux/install.sh "$STAGE/install.sh"
mkdir -p "$STAGE/docker" "$STAGE/systemd"
cp packaging/docker/Dockerfile "$STAGE/docker/"
install -m 755 packaging/linux/docker-start.sh "$STAGE/docker/"
cp packaging/linux/hyperplayer-server.service packaging/linux/hyperplayer-docker.service "$STAGE/systemd/"
echo "$VERSION" >"$STAGE/VERSION"
cat >"$STAGE/README.txt" <<EOF
HyperPlayer $VERSION for Linux (x64)

Install, upgrade or change settings:   sudo ./install.sh
Uninstall:                             sudo ./install.sh --uninstall
EOF

tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
echo "==> $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"

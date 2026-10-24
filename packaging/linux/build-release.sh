#!/usr/bin/env bash
# Builds the Linux release bundle: release/hyperplayer-<version>-linux-x64.tar.gz, with
# the installer, the bundled server (with its Node.js and sharp), the Docker build
# files, the systemd unit and the player's .deb.
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
vp run @hyperplayer/schemas#generate
(cd apps/server && vp pack)
mkdir -p "$STAGE/server"
cp -a apps/server/dist "$STAGE/server/dist"
# The Node.js that runs the server, so hosts don't need one.
NODE=$(command -v node)
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' || {
  echo "Node.js >= 22.18 is needed to build the bundle" >&2
  exit 1
}
cp "$(readlink -f "$NODE")" "$STAGE/server/node"
SHARP=$(node -p 'require("./apps/server/node_modules/sharp/package.json").version')
cat >"$STAGE/server/package.json" <<EOF
{ "name": "hyperplayer-server", "version": "$VERSION", "private": true, "type": "module",
  "dependencies": { "sharp": "$SHARP" } }
EOF
(cd "$STAGE/server" && npm install --omit=dev --no-package-lock --no-audit --no-fund --os=linux --cpu=x64 --libc=glibc --loglevel=error)

echo "==> Player"
cargo build --release -p hyperplayer
DEB=$OUT/deb
rm -rf "$DEB"
mkdir -p "$DEB/DEBIAN" "$DEB/usr/bin" "$DEB/usr/share/applications" "$DEB/usr/share/icons/hicolor/scalable/apps"
install -m 755 target/release/hyperplayer "$DEB/usr/bin/hyperplayer"
strip "$DEB/usr/bin/hyperplayer"
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
Section: sound
Priority: optional
Description: HyperPlayer music player
 The native player for a HyperPlayer server: browse the library, stream in the
 best quality the connection sustains, lyrics, history and scrobbling.
EOF
mkdir -p "$STAGE/player"
fakeroot dpkg-deb --build -Zxz "$DEB" "$STAGE/player/hyperplayer_${VERSION/-/\~}_amd64.deb" >/dev/null
rm -rf "$DEB"

echo "==> Player (Flatpak)"
if flatpak info org.flatpak.Builder >/dev/null 2>&1; then
  packaging/flatpak/build.sh
  cp "$OUT/hyperplayer-$VERSION-x86_64.flatpak" "$STAGE/player/"
else
  echo "Skipped: no org.flatpak.Builder (see packaging/flatpak/build.sh)" >&2
fi

echo "==> Installer"
install -m 755 packaging/linux/install.sh "$STAGE/install.sh"
mkdir -p "$STAGE/docker" "$STAGE/systemd"
cp packaging/docker/Dockerfile "$STAGE/docker/"
cp packaging/linux/hyperplayer-server.service "$STAGE/systemd/"
echo "$VERSION" >"$STAGE/VERSION"
cat >"$STAGE/README.txt" <<EOF
HyperPlayer $VERSION for Linux (x64)

Install, upgrade or change settings:   sudo ./install.sh
Uninstall:                             sudo ./install.sh --uninstall
EOF

tar -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
echo "==> $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"

#!/usr/bin/env bash
# Builds the player's Flatpak: release/hyperplayer-<version>-x86_64.flatpak, a single-file
# bundle that fetches its runtime from Flathub when installed:
#
#   flatpak install --user hyperplayer-<version>-x86_64.flatpak
#
# Needs Flathub's builder and SDK (once, per user):
#   flatpak install --user flathub org.flatpak.Builder org.freedesktop.Sdk//26.08 \
#     org.freedesktop.Sdk.Extension.rust-stable//26.08
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/apps/client/Cargo.toml" | head -1)
WORK=$ROOT/release/flatpak
OUT=$ROOT/release/hyperplayer-$VERSION-x86_64.flatpak
mkdir -p "$WORK"

flatpak run --filesystem="$ROOT" org.flatpak.Builder \
  --force-clean --disable-rofiles-fuse \
  --state-dir="$WORK/state" --repo="$WORK/repo" \
  "$WORK/build" "$ROOT/packaging/flatpak/io.ansaloni.HyperPlayer.yml"
flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  "$WORK/repo" "$OUT" io.ansaloni.HyperPlayer
echo "==> $OUT ($(du -h "$OUT" | cut -f1))"

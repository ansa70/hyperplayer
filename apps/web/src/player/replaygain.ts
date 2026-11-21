// ReplayGain, as the Rust player applies it (apps/client/src/replaygain.rs).

import type { Preferences, ReplayGain } from "@hyperplayer/schemas";
import { t } from "../i18n.ts";

export type RgMode = Preferences["replayGain"];

export interface Applied {
  db: number;
  linear: number;
  basis: "track" | "album" | null;
  /** Held back so the tagged peak doesn't clip. */
  limited: boolean;
}

export const UNITY: Applied = { db: 0, linear: 1, basis: null, limited: false };

export const NEXT_MODE: Record<RgMode, RgMode> = { auto: "track", track: "album", album: "off", off: "auto" };

/**
 * The gain for a track: album gain while an album plays in order (`auto`), track gain
 * otherwise, falling back to whichever tag exists; plus the pre-amp, capped so the
 * tagged peak never clips.
 */
export function compute(rg: ReplayGain, mode: RgMode, inAlbumOrder: boolean, preampDb: number): Applied {
  const track =
    rg.trackGain !== null ? { gain: rg.trackGain, peak: rg.trackPeak, basis: "track" as const } : null;
  const album =
    rg.albumGain !== null ? { gain: rg.albumGain, peak: rg.albumPeak, basis: "album" as const } : null;
  const chosen =
    mode === "off"
      ? null
      : mode === "track" || (mode === "auto" && !inAlbumOrder)
        ? (track ?? album)
        : (album ?? track);
  if (!chosen) return UNITY;
  const db = chosen.gain + preampDb;
  const linear = Math.pow(10, db / 20);
  const peak = chosen.peak;
  if (peak !== null && peak > 0 && linear * peak > 1) {
    const capped = 1 / peak;
    return { db: 20 * Math.log10(capped), linear: capped, basis: chosen.basis, limited: true };
  }
  return { db, linear, basis: chosen.basis, limited: false };
}

/**
 * The gain for a track with its own volume adjustment (`Track.volumeDb`) on top: added to
 * the pre-amp, and applied by itself when ReplayGain applies nothing (no tags, or off).
 */
export function withVolume(
  rg: ReplayGain,
  mode: RgMode,
  inAlbumOrder: boolean,
  preampDb: number,
  volumeDb: number,
): Applied {
  const applied = compute(rg, mode, inAlbumOrder, preampDb + volumeDb);
  if (applied.basis || !volumeDb) return applied;
  return { db: volumeDb, linear: Math.pow(10, volumeDb / 20), basis: null, limited: false };
}

/** E.g. "RG −6.4 dB track", or nothing when no gain applies. */
export function label(a: Applied): string {
  if (!a.basis) return "";
  const gain = `${a.db < 0 ? "−" : "+"}${Math.abs(a.db).toFixed(1)}`;
  if (a.basis === "track")
    return a.limited ? t("RG {} dB track, peak-limited", gain) : t("RG {} dB track", gain);
  return a.limited ? t("RG {} dB album, peak-limited", gain) : t("RG {} dB album", gain);
}

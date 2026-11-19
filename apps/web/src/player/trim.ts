// Trimming silence off tracks, as in the Rust player (apps/client/src/ui/trim.rs).

import type { Silence, Track, TrackTrim } from "@hyperplayer/schemas";
import { api, call } from "../api.ts";
import { duration } from "../format.ts";
import { usePlayer } from "../stores/player.ts";
import { t } from "../i18n.ts";

/** Silence this long at either end is offered for trimming: a hidden track's wait, not a fade-out's tail. */
const LONG_GAP_MS = 10_000;
/** Left before the music starts, and after it ends. */
const LEAD_IN_MS = 500;
const TAIL_MS = 1_000;

/** The trim skipping `silence`'s long gaps, and words for it; null without long gaps. */
export function suggest(durationMs: number, silence: Silence): { trim: TrackTrim; text: string } | null {
  const leading = silence.leadingMs >= LONG_GAP_MS;
  const trailing = silence.trailingMs >= LONG_GAP_MS;
  const music = durationMs - silence.leadingMs - silence.trailingMs;
  if (!(leading || trailing) || music < LONG_GAP_MS) return null;
  const trim: TrackTrim = {
    startMs: leading ? Math.max(0, silence.leadingMs - LEAD_IN_MS) : null,
    endMs: trailing ? Math.max(1, durationMs - silence.trailingMs + TAIL_MS) : null,
  };
  const at =
    leading && trailing
      ? t(
          "{} of silence at the start of this track and {} at the end.",
          duration(silence.leadingMs),
          duration(silence.trailingMs),
        )
      : leading
        ? t("{} of silence at the start of this track.", duration(silence.leadingMs))
        : t("{} of silence at the end of this track.", duration(silence.trailingMs));
  return {
    trim,
    text: t(
      "{} Skip it whenever it plays, for everyone? Right-click (or long-press) the waveform to change it later.",
      at,
    ),
  };
}

/** The trim after picking `kind` at `seconds` on the waveform. */
export function picked(track: Track, kind: "start" | "end" | "clear", seconds: number): TrackTrim {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const old = track.trim ?? { startMs: null, endMs: null };
  if (kind === "start")
    return { startMs: ms > 0 ? ms : null, endMs: old.endMs !== null && old.endMs > ms ? old.endMs : null };
  if (kind === "end")
    return { startMs: old.startMs !== null && old.startMs < ms ? old.startMs : null, endMs: Math.max(1, ms) };
  return { startMs: null, endMs: null };
}

/** Saves a track's trim for everyone, and plays by it. */
export async function saveTrim(track: Track, trim: TrackTrim) {
  const updated = await call(api.setTrackTrim, { params: { id: track.id }, body: trim });
  usePlayer.getState().replaceTrack(updated);
}

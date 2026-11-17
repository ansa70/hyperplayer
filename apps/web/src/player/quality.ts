// What to stream for a track: the file itself when this browser plays it and the
// connection allows, otherwise a transcode to a lossy format the browser plays.

import type { Preferences, StreamFormat, Track } from "@hyperplayer/schemas";
import { api, url } from "../api.ts";

export type Mode = Preferences["quality"];

export interface Stream {
  url: string;
  /** Transcodes can't seek by byte range: seeking reopens them at `start`. */
  seekable: boolean;
  /** Shown in the player, e.g. "FLAC 24/96" or "Opus 192". */
  label: string;
}

const CONTAINER_MIME: Record<string, string> = {
  mpeg: "audio/mpeg",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  "m4a/mp4": "audio/mp4",
  wave: "audio/wav",
  wav: "audio/wav",
  aiff: "audio/aiff",
};

const probe = typeof Audio === "undefined" ? null : new Audio();
const playable = (mime: string) => (probe ? probe.canPlayType(mime) !== "" : false);

/** Whether this browser decodes `track`'s file as it is (Chrome and Firefox don't play ALAC). */
function playsOriginal(track: Track): boolean {
  const mime = CONTAINER_MIME[track.format.container.toLowerCase()];
  if (!mime) return false;
  if (mime === "audio/mp4" && track.format.codec.toLowerCase() === "alac") {
    return playable('audio/mp4; codecs="alac"');
  }
  return playable(mime);
}

/** The lossy format this browser plays best: Opus, else AAC (Safari), else MP3. */
const LOSSY: { format: StreamFormat; label: string } = playable('audio/ogg; codecs="opus"')
  ? { format: "opus", label: "Opus" }
  : playable("audio/aac")
    ? { format: "aac", label: "AAC" }
    : { format: "mp3", label: "MP3" };

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * A slow or metered connection, where the browser tells (Chrome, mostly on Android):
 * data saver on, or a connection it rates 3G or slower. Its bandwidth estimate
 * (`downlink`) is too rough to go by: it reads 1.5 Mbit/s on a gigabit LAN.
 */
function constrained(): boolean {
  const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!c) return false;
  return c.saveData === true || ["slow-2g", "2g", "3g"].includes(c.effectiveType ?? "");
}

function originalLabel(track: Track): string {
  const f = track.format;
  const codec = f.codec.toUpperCase();
  if (f.lossless && f.bitDepth && f.sampleRate) {
    const khz = f.sampleRate / 1000;
    return `${codec} ${f.bitDepth}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}`;
  }
  return f.bitrate ? `${codec} ${Math.round(f.bitrate / 1000)}` : codec;
}

/** The stream to play `track` with in `mode`, from `start` seconds (transcodes). */
export function chooseStream(track: Track, mode: Mode, start = 0): Stream {
  const original = playsOriginal(track);
  const lossyFile = !track.format.lossless;
  const wantOriginal =
    original && (mode === "original" || (mode === "auto" && (!constrained() || lossyFile)));
  if (wantOriginal) {
    return {
      url: url(api.stream.path, { id: track.id }, { format: "original" }),
      seekable: true,
      label: originalLabel(track),
    };
  }
  const kbps = mode === "data-saver" || constrained() ? 128 : 256;
  const startAt = start > 0 ? start.toFixed(3) : undefined;
  return {
    url: url(api.stream.path, { id: track.id }, { format: LOSSY.format, bitrate: kbps, start: startAt }),
    seekable: false,
    label: `${LOSSY.label} ${kbps}`,
  };
}

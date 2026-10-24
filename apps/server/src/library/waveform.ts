import { spawn } from "node:child_process";
import type { Waveform } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";

type Row = Record<string, unknown>;

/** Bars across a seek bar: enough for any window width, small to send. */
export const POINTS = 480;
/** Decoding rate: the envelope needs no more, and ffmpeg resamples cheaply. */
const RATE = 8000;

/**
 * Reduces mono 16-bit PCM to `points` bar heights (0..100): the peak of each
 * slice, relative to the loudest, with a gentle curve so quiet passages stay
 * visible rather than flattening to nothing.
 */
export function envelope(pcm: Int16Array, points = POINTS): number[] {
  if (pcm.length === 0) return Array.from({ length: points }, () => 0);
  const peaks = new Float64Array(points);
  for (let i = 0; i < pcm.length; i++) {
    const slot = Math.min(points - 1, Math.floor((i * points) / pcm.length));
    const v = Math.abs(pcm[i]!);
    if (v > peaks[slot]!) peaks[slot] = v;
  }
  const max = Math.max(...peaks, 1);
  return Array.from(peaks, (p) => Math.round(Math.pow(p / max, 0.7) * 100));
}

/** Decodes a file to mono 8 kHz PCM with ffmpeg. */
function decode(ffmpeg: string, path: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        String(RATE),
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

/**
 * Waveforms for seek bars, computed on first request and cached until the file
 * changes. One decode runs at a time, so a burst of requests can't swamp the
 * server (or a network share); repeated requests for a track share one decode.
 */
export class Waveforms {
  readonly #db: Db;
  readonly #ffmpeg: string;
  readonly #inFlight = new Map<string, Promise<Waveform>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: Db, ffmpeg: string) {
    this.#db = db;
    this.#ffmpeg = ffmpeg;
  }

  /** Null when the track doesn't exist. */
  get(trackId: string): Promise<Waveform> | null {
    const track = this.#db.prepare("SELECT path, mtime_ms FROM tracks WHERE id = ?").get(trackId) as
      | Row
      | undefined;
    if (!track) return null;
    const mtime = Number(track.mtime_ms);
    const cached = this.#db
      .prepare("SELECT track_mtime, points FROM waveforms WHERE track_id = ?")
      .get(trackId) as Row | undefined;
    if (cached && Number(cached.track_mtime) === mtime) {
      return Promise.resolve({ trackId, points: JSON.parse(String(cached.points)) as number[] });
    }
    let pending = this.#inFlight.get(trackId);
    if (!pending) {
      const run = async () => {
        const points = envelope(await decode(this.#ffmpeg, String(track.path)));
        this.#db
          .prepare("INSERT OR REPLACE INTO waveforms (track_id, track_mtime, points) VALUES (?, ?, ?)")
          .run(trackId, mtime, JSON.stringify(points));
        return { trackId, points };
      };
      pending = this.#queue.then(run, run).finally(() => this.#inFlight.delete(trackId));
      this.#queue = pending.catch(() => undefined);
      this.#inFlight.set(trackId, pending);
    }
    return pending;
  }
}

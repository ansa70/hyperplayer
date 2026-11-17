import { spawn } from "node:child_process";
import type { Silence, Waveform } from "@hyperplayer/schemas";
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

/** Quieter than this (-60 dBFS) counts as silence: digital silence, or close to it. */
const SILENT = Math.round(32768 * Math.pow(10, -60 / 20));

/** How long the audio is silent at its start and at its end (all of it when it's all silent). */
export function silence(pcm: Int16Array, rate = RATE): Silence {
  const ms = (samples: number) => Math.round((samples * 1000) / rate);
  let first = 0;
  while (first < pcm.length && Math.abs(pcm[first]!) <= SILENT) first++;
  if (first === pcm.length) return { leadingMs: ms(pcm.length), trailingMs: ms(pcm.length) };
  let last = pcm.length - 1;
  while (Math.abs(pcm[last]!) <= SILENT) last--;
  return { leadingMs: ms(first), trailingMs: ms(pcm.length - 1 - last) };
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
  /** Waveforms of tracks on a server (a standalone player's sources) come from the server. */
  readonly #remote: (trackId: string) => Promise<Omit<Waveform, "trackId">> | null;
  readonly #inFlight = new Map<string, Promise<Waveform>>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    db: Db,
    ffmpeg: string,
    remote: (trackId: string) => Promise<Omit<Waveform, "trackId">> | null = () => null,
  ) {
    this.#db = db;
    this.#ffmpeg = ffmpeg;
    this.#remote = remote;
  }

  /** Null when the track doesn't exist. */
  get(trackId: string): Promise<Waveform> | null {
    const track = this.#db
      .prepare("SELECT path, mtime_ms, source_id FROM tracks WHERE id = ?")
      .get(trackId) as Row | undefined;
    if (!track) return null;
    const mtime = Number(track.mtime_ms);
    const cached = this.#db
      .prepare(
        "SELECT track_mtime, points, leading_silence_ms, trailing_silence_ms FROM waveforms WHERE track_id = ?",
      )
      .get(trackId) as Row | undefined;
    const known = cached?.leading_silence_ms != null;
    // Waveforms cached before silence was looked for are worked out again; a server's
    // track keeps what its server said (it may be too old to say).
    if (cached && Number(cached.track_mtime) === mtime && (known || track.source_id != null)) {
      return Promise.resolve({
        trackId,
        points: JSON.parse(String(cached.points)) as number[],
        silence: known
          ? { leadingMs: Number(cached.leading_silence_ms), trailingMs: Number(cached.trailing_silence_ms) }
          : null,
      });
    }
    let pending = this.#inFlight.get(trackId);
    if (!pending) {
      const run = async (): Promise<Waveform> => {
        let found = await this.#remote(trackId);
        if (!found) {
          const pcm = await decode(this.#ffmpeg, String(track.path));
          found = { points: envelope(pcm), silence: silence(pcm) };
        }
        this.#db
          .prepare(
            `INSERT OR REPLACE INTO waveforms (track_id, track_mtime, points, leading_silence_ms, trailing_silence_ms)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            trackId,
            mtime,
            JSON.stringify(found.points),
            found.silence?.leadingMs ?? null,
            found.silence?.trailingMs ?? null,
          );
        return { trackId, ...found };
      };
      pending = this.#queue.then(run, run).finally(() => this.#inFlight.delete(trackId));
      this.#queue = pending.catch(() => undefined);
      this.#inFlight.set(trackId, pending);
    }
    return pending;
  }
}

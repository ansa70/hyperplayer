import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { StreamFormat } from "@hyperplayer/schemas";

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

export const mimeForContainer = (container: string) =>
  CONTAINER_MIME[container.toLowerCase()] ?? "application/octet-stream";

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * Parses a single-range `Range: bytes=…` header. Returns `null` when the header
 * is absent or malformed (serve the whole file) and `"unsatisfiable"` for a
 * syntactically valid range outside the file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // Suffix range: last N bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export const openFile = (path: string, range?: ByteRange): Readable =>
  createReadStream(path, range ? { start: range.start, end: range.end } : {});

/** Lossy encoders top out at 48 kHz (libvorbis fails outright on 96/192 kHz sources). */
const LOSSY_RATE = ["-ar", "48000"];

const TRANSCODE: Record<
  Exclude<StreamFormat, "original">,
  { args: (kbps: number) => string[]; mime: string; defaultKbps: number }
> = {
  opus: {
    args: (k) => ["-c:a", "libopus", "-b:a", `${k}k`, ...LOSSY_RATE, "-f", "ogg"],
    mime: "audio/ogg",
    defaultKbps: 160,
  },
  aac: {
    args: (k) => ["-c:a", "aac", "-b:a", `${k}k`, ...LOSSY_RATE, "-f", "adts"],
    mime: "audio/aac",
    defaultKbps: 256,
  },
  mp3: {
    args: (k) => ["-c:a", "libmp3lame", "-b:a", `${k}k`, ...LOSSY_RATE, "-f", "mp3"],
    mime: "audio/mpeg",
    defaultKbps: 320,
  },
  vorbis: {
    args: (k) => ["-c:a", "libvorbis", "-b:a", `${k}k`, ...LOSSY_RATE, "-f", "ogg"],
    mime: "audio/ogg",
    defaultKbps: 192,
  },
  flac: { args: () => ["-c:a", "flac", "-f", "flac"], mime: "audio/flac", defaultKbps: 0 },
};

export class TranscodeError extends Error {}

/**
 * Transcodes `path` on the fly. Resolves once ffmpeg has produced its first
 * bytes, so a failing encoder becomes an error response rather than an empty
 * 200. The process is killed via `kill` (e.g. when the client disconnects).
 */
export async function transcode(
  ffmpeg: string,
  path: string,
  format: Exclude<StreamFormat, "original">,
  bitrateKbps?: number,
  startSeconds?: number,
): Promise<{ stream: Readable; mime: string; kill: () => void }> {
  const spec = TRANSCODE[format];
  const proc = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      // Before -i: fast input seek, so resuming mid-track starts immediately.
      ...(startSeconds ? ["-ss", startSeconds.toFixed(3)] : []),
      "-i",
      path,
      "-map",
      "0:a:0",
      "-vn",
      ...spec.args(bitrateKbps ?? spec.defaultKbps),
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
    console.warn(`ffmpeg: ${d.toString().trim()}`);
  });
  const kill = () => proc.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      proc.stdout.off("readable", onReadable);
      proc.off("error", onError);
      proc.off("close", onClose);
    };
    // "readable" also fires at end-of-stream: only buffered bytes mean ffmpeg is producing audio.
    const onReadable = () => {
      if (proc.stdout.readableLength > 0) {
        cleanup();
        resolve();
      }
    };
    const fail = (why: string) => {
      cleanup();
      kill();
      reject(new TranscodeError(`ffmpeg ${format} transcode failed: ${why}`));
    };
    const onError = (err: Error) => fail(err.message);
    const onClose = (code: number | null) => fail(stderr.trim().split("\n").at(-1) || `exit code ${code}`);
    proc.stdout.on("readable", onReadable);
    proc.once("error", onError);
    proc.once("close", onClose);
  });
  return { stream: proc.stdout, mime: spec.mime, kill };
}

/**
 * Development aid: limits a stream to `kbps` to exercise clients' adaptive
 * streaming on a fast network (HP_DEBUG_THROTTLE_KBPS).
 */
export function throttle(source: Readable, kbps: number): Readable {
  const bytesPerSecond = (kbps * 1000) / 8;
  const started = Date.now();
  let sent = 0;
  return Readable.from(
    (async function* () {
      for await (const chunk of source) {
        // Re-slice so a large chunk doesn't arrive as one burst.
        for (let i = 0; i < (chunk as Buffer).length; i += 16 * 1024) {
          const piece = (chunk as Buffer).subarray(i, i + 16 * 1024);
          sent += piece.length;
          const due = started + (sent / bytesPerSecond) * 1000;
          const wait = due - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          yield piece;
        }
      }
    })(),
  );
}

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
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

const TRANSCODE: Record<
  Exclude<StreamFormat, "original">,
  { args: (kbps: number) => string[]; mime: string; defaultKbps: number }
> = {
  opus: {
    args: (k) => ["-c:a", "libopus", "-b:a", `${k}k`, "-f", "ogg"],
    mime: "audio/ogg",
    defaultKbps: 160,
  },
  aac: { args: (k) => ["-c:a", "aac", "-b:a", `${k}k`, "-f", "adts"], mime: "audio/aac", defaultKbps: 256 },
  mp3: {
    args: (k) => ["-c:a", "libmp3lame", "-b:a", `${k}k`, "-f", "mp3"],
    mime: "audio/mpeg",
    defaultKbps: 320,
  },
  flac: { args: () => ["-c:a", "flac", "-f", "flac"], mime: "audio/flac", defaultKbps: 0 },
};

/** Transcodes `path` on the fly; the ffmpeg process is killed if the client disconnects. */
export function transcode(
  ffmpeg: string,
  path: string,
  format: Exclude<StreamFormat, "original">,
  bitrateKbps?: number,
): { stream: Readable; mime: string; kill: () => void } {
  const spec = TRANSCODE[format];
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
      "-vn",
      ...spec.args(bitrateKbps ?? spec.defaultKbps),
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr.on("data", (d: Buffer) => console.warn(`ffmpeg: ${d.toString().trim()}`));
  proc.on("error", (err) => proc.stdout.destroy(err));
  return { stream: proc.stdout, mime: spec.mime, kill: () => proc.kill("SIGKILL") };
}

import { Readable } from "node:stream";
import type { Fetch } from "../history/scrobbler.ts";
import { fetchFollowing } from "./net.ts";

/**
 * A station's live stream, as the server fetches it. Its address may be the stream itself
 * or a playlist of it (`.pls`, `.m3u`, which ffmpeg doesn't read), or HLS (which ffmpeg
 * does). Shoutcast/Icecast streams carry the song playing in-band (ICY metadata): it's
 * taken out of the audio and reported through `onTitle`.
 */

/** Stream types played as they come (by the players that can). */
const DIRECT: Record<string, LiveCodec> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpeg3": "mp3",
  "audio/x-mpeg": "mp3",
  "audio/aac": "aac",
  "audio/aacp": "aac",
  "audio/x-aac": "aac",
};

export type LiveCodec = "mp3" | "aac";

const PLAYLIST_TYPES = new Set([
  "audio/x-scpls",
  "application/pls+xml",
  "audio/x-mpegurl",
  "audio/mpegurl",
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
  "audio/x-pn-realaudio",
]);
const PLAYLIST_MAX_BYTES = 64 << 10;
/** Playlists that list playlists are followed this deep. */
const PLAYLIST_DEPTH = 3;

export type Upstream =
  /** Fetched here: `codec` null for a type that needs ffmpeg to be played (Ogg, say). */
  | { kind: "fetched"; res: Response; url: URL; codec: LiveCodec | null; mime: string }
  /** For ffmpeg to read itself: HLS, or a server fetch can't talk to (Shoutcast's `ICY 200`). */
  | { kind: "ffmpeg"; url: string };

export class StationUnavailable extends Error {}

const typeOf = (res: Response) => res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";

async function text(res: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= PLAYLIST_MAX_BYTES) break;
  }
  await res.body?.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

/** The first stream address a `.pls` or plain `.m3u` playlist lists. */
export function playlistEntry(body: string, base: URL): string | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const pls = lines.some((l) => /^\[playlist\]$/i.test(l) || /^File\d+\s*=/i.test(l));
  for (const line of lines) {
    // A .pls lists its streams as `FileN=…`; an .m3u has them on lines of their own.
    const entry = pls ? /^File\d+\s*=\s*(.+)$/i.exec(line)?.[1] : line && !line.startsWith("#") ? line : null;
    if (!entry) continue;
    try {
      const url = new URL(entry.trim(), base);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // Not an address: the next line.
    }
  }
  return null;
}

/** Connects to a station: follows its playlists, and tells what kind of stream it is. */
export async function connect(
  fetch: Fetch,
  address: string,
  opts: { allowPrivate: boolean; userAgent: string; signal: AbortSignal },
  depth = 0,
): Promise<Upstream> {
  let got: { res: Response; url: URL };
  try {
    got = await fetchFollowing(
      fetch,
      address,
      {
        headers: { "User-Agent": opts.userAgent, "Icy-MetaData": "1", Accept: "*/*" },
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]),
      },
      opts.allowPrivate,
    );
  } catch (err) {
    if (opts.signal.aborted || !(err instanceof TypeError)) throw err;
    // E.g. an old Shoutcast answering `ICY 200 OK`, which isn't HTTP: ffmpeg understands it.
    return { kind: "ffmpeg", url: address };
  }
  const { res, url } = got;
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new StationUnavailable(`The station answered ${res.status}`);
  }
  const type = typeOf(res);
  const codec = DIRECT[type];
  if (codec) return { kind: "fetched", res, url, codec, mime: type === "audio/aacp" ? "audio/aac" : type };
  const path = url.pathname.toLowerCase();
  const playlistLike =
    PLAYLIST_TYPES.has(type) ||
    ((type.startsWith("text/") || type === "application/octet-stream" || type === "") &&
      /\.(pls|m3u8?)$/.test(path));
  if (playlistLike) {
    const body = await text(res);
    if (body.includes("#EXT-X-")) return { kind: "ffmpeg", url: url.href };
    const entry = playlistEntry(body, url);
    if (!entry || depth >= PLAYLIST_DEPTH)
      throw new StationUnavailable("The station's playlist lists no stream");
    return connect(fetch, entry, opts, depth + 1);
  }
  if (
    type.startsWith("audio/") ||
    type.startsWith("application/ogg") ||
    type === "application/octet-stream"
  ) {
    return { kind: "fetched", res, url, codec: null, mime: type };
  }
  await res.body?.cancel().catch(() => {});
  throw new StationUnavailable(`The station's address doesn't give audio (${type || "no type"})`);
}

/** The song in an ICY metadata block (`StreamTitle='Artist - Song';…`), or null. */
export function icyTitle(block: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(block);
  } catch {
    // Older servers send Latin-1.
    text = new TextDecoder("latin1").decode(block);
  }
  const m = /StreamTitle='([\s\S]*?)';(?=\s*(?:[A-Za-z]+=|\0|$))/.exec(text.replace(/\0+$/, ""));
  const title = m?.[1]?.trim();
  return title ? title : null;
}

/** The audio of an ICY stream, its metadata blocks (every `metaint` bytes) taken out. */
export async function* stripIcy(
  body: AsyncIterable<Uint8Array>,
  metaint: number,
  onTitle: (title: string | null) => void,
): AsyncGenerator<Uint8Array> {
  let mode: "audio" | "length" | "meta" = "audio";
  let left = metaint;
  let meta: Uint8Array[] = [];
  for await (const chunk of body) {
    let i = 0;
    while (i < chunk.length) {
      if (mode === "audio") {
        const n = Math.min(left, chunk.length - i);
        yield chunk.subarray(i, i + n);
        i += n;
        left -= n;
        if (left === 0) mode = "length";
      } else if (mode === "length") {
        left = chunk[i++]! * 16;
        meta = [];
        if (left) mode = "meta";
        else [mode, left] = ["audio", metaint];
      } else {
        const n = Math.min(left, chunk.length - i);
        meta.push(chunk.slice(i, i + n));
        i += n;
        left -= n;
        if (left === 0) {
          onTitle(icyTitle(Buffer.concat(meta)));
          [mode, left] = ["audio", metaint];
        }
      }
    }
  }
}

/** Times in a row a dropped stream is reconnected, before giving up. */
const RECONNECTS = 5;
/** Data that counts as the stream working again (resets the reconnect count). */
const HEALTHY_BYTES = 256 << 10;

/**
 * The audio of a fetched stream as one endless stream: when the station drops the
 * connection, it's reconnected (a few times, waiting longer each time) and the audio
 * goes on. MP3 and AAC decoders find their way back in at the seam.
 */
export function liveAudio(
  first: Extract<Upstream, { kind: "fetched" }>,
  reconnect: () => Promise<Upstream>,
  signal: AbortSignal,
  onTitle: (title: string | null) => void,
): Readable {
  async function* audio(): AsyncGenerator<Uint8Array> {
    let current: Upstream | null = first;
    let failures = 0;
    for (;;) {
      if (current?.kind === "fetched" && current.res.body) {
        const metaint = Number(current.res.headers.get("icy-metaint"));
        const body = current.res.body as AsyncIterable<Uint8Array>;
        let received = 0;
        try {
          for await (const chunk of metaint > 0 ? stripIcy(body, metaint, onTitle) : body) {
            received += chunk.length;
            if (received >= HEALTHY_BYTES) failures = 0;
            yield chunk;
          }
        } catch {
          // Dropped: reconnected below.
        }
      }
      if (signal.aborted || ++failures > RECONNECTS) return;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (failures - 1)));
      if (signal.aborted) return;
      current = await reconnect().catch(() => null);
      // Reconnected to something that isn't this kind of stream any more: stop rather than mix.
      if (current?.kind === "ffmpeg") return;
    }
  }
  return Readable.from(audio(), { objectMode: false });
}

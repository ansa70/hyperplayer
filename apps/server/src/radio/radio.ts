import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type {
  AddRadioStation,
  RadioCodec,
  RadioFacet,
  RadioNowPlaying,
  RadioStation,
} from "@hyperplayer/schemas";
import sharp from "sharp";
import { newId } from "../collections/sources.ts";
import type { Db } from "../db.ts";
import type { Fetch } from "../history/scrobbler.ts";
import { HttpError, notFound } from "../http/contract.ts";
import { transcode, TranscodeError } from "../stream/stream.ts";
import { connect, liveAudio, StationUnavailable } from "./live.ts";
import { fetchFollowing, Refused } from "./net.ts";
import { DirectoryUnavailable, RadioDirectory, type StationQuery, type StationRecord } from "./directory.ts";

const LOGO_MAX_BYTES = 2 << 20;
/** Logos are kept at this size and scaled down from it. */
const LOGO_STORED = 512;
/** A logo that couldn't be had is tried again after this long. */
const LOGO_RETRY_MS = 24 * 3600_000;

/** A station's audio that hasn't started by then is given up on. */
const FIRST_AUDIO_MS = 20_000;
/** A user playing a station again within this long isn't reported to the directory again. */
const CLICK_INTERVAL_MS = 3600_000;
/** For ffmpeg reading a station itself (HLS, old Shoutcast): reconnecting, and the web only. */
const FFMPEG_LIVE_INPUT = [
  "-reconnect",
  "1",
  "-reconnect_streamed",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_delay_max",
  "8",
  "-rw_timeout",
  "15000000",
  "-protocol_whitelist",
  "http,https,tls,tcp,crypto",
];

export interface LiveQuery {
  direct: RadioCodec[];
  format: "mp3" | "aac" | "opus" | "vorbis";
  bitrate: number;
}

/** The directory's failure, as the API reports it. */
const unavailable = (err: unknown): never => {
  if (err instanceof DirectoryUnavailable)
    throw new HttpError(502, "radio_directory_unavailable", err.message);
  throw err;
};

/** The largest PNG image in an .ico file (sharp reads PNG, not the icon format). */
export function pngFromIco(data: Uint8Array): Uint8Array | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 6 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null;
  const count = view.getUint16(4, true);
  let best: { size: number; image: Uint8Array } | null = null;
  for (let i = 0; i < count && 6 + (i + 1) * 16 <= data.length; i++) {
    const entry = 6 + i * 16;
    const size = (data[entry] || 256) * (data[entry + 1] || 256);
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (offset + length > data.length) continue;
    const image = data.subarray(offset, offset + length);
    const png = image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
    if (png && (!best || size > best.size)) best = { size, image };
  }
  return best?.image ?? null;
}

/** Internet radio: the directory, each user's favourites and the stations they added, logos. */
export class Radio {
  readonly #db: Db;
  readonly #fetch: Fetch;
  readonly #userAgent: string;
  readonly #logoDir: string;
  readonly directory: RadioDirectory;
  readonly #logoFailed = new Map<string, number>();
  readonly #logoLoading = new Map<string, Promise<string | null>>();
  readonly #ffmpeg: string;
  /** Per station being listened to: how many streams, and the song it last said was playing. */
  readonly #live = new Map<string, { listeners: number; title: string | null }>();
  readonly #clicked = new Map<string, number>();

  constructor(
    db: Db,
    opts: { userAgent: string; dataDir: string; ffmpeg: string; fetch?: Fetch | undefined },
  ) {
    this.#db = db;
    this.#ffmpeg = opts.ffmpeg;
    this.#userAgent = opts.userAgent;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#logoDir = join(opts.dataDir, "radio-logos");
    this.directory = new RadioDirectory({ userAgent: opts.userAgent, fetch: opts.fetch });
  }

  #favourites(userId: string): Map<string, StationRecord> {
    const rows = this.#db
      .prepare("SELECT station FROM radio_favourites WHERE user_id = ? ORDER BY added_at, rowid")
      .all(userId) as { station: string }[];
    const stations = rows.map((r) => JSON.parse(r.station) as StationRecord);
    return new Map(stations.map((s) => [s.id, s]));
  }

  #show(station: StationRecord, favourite: boolean): RadioStation {
    const { logoUrl, ...rest } = station;
    return { ...rest, hasLogo: logoUrl !== null, favourite };
  }

  /** Brings the caller's saved copies of these directory stations up to date. */
  #refresh(userId: string, stations: StationRecord[], favourites: Map<string, StationRecord>) {
    const update = this.#db.prepare(
      "UPDATE radio_favourites SET station = ? WHERE user_id = ? AND station_id = ?",
    );
    for (const s of stations) {
      if (favourites.has(s.id) && JSON.stringify(favourites.get(s.id)) !== JSON.stringify(s)) {
        update.run(JSON.stringify(s), userId, s.id);
      }
    }
  }

  async search(userId: string, query: StationQuery) {
    const page = await this.directory.search(query).catch(unavailable);
    const favourites = this.#favourites(userId);
    this.#refresh(userId, page.items, favourites);
    return {
      items: page.items.map((s) => this.#show(s, favourites.has(s.id))),
      offset: query.offset,
      limit: query.limit,
      more: page.more,
    };
  }

  /**
   * A station the caller can play: one they added, or the directory's (their saved copy
   * when the directory can't be reached or no longer lists it).
   */
  async record(userId: string, id: string): Promise<{ station: StationRecord; favourite: boolean }> {
    const favourites = this.#favourites(userId);
    const saved = favourites.get(id);
    if (id.startsWith("custom-")) {
      if (!saved) throw notFound("Station");
      return { station: saved, favourite: true };
    }
    let found: StationRecord | null;
    try {
      found = await this.directory.station(id);
    } catch (err) {
      if (saved) return { station: saved, favourite: true };
      return unavailable(err);
    }
    if (found) {
      this.#refresh(userId, [found], favourites);
      return { station: found, favourite: !!saved };
    }
    if (saved) return { station: saved, favourite: true };
    throw notFound("Station");
  }

  async station(userId: string, id: string): Promise<RadioStation> {
    const { station, favourite } = await this.record(userId, id);
    return this.#show(station, favourite);
  }

  favourites(userId: string): { items: RadioStation[] } {
    return { items: [...this.#favourites(userId).values()].map((s) => this.#show(s, true)) };
  }

  async addFavourite(userId: string, id: string): Promise<RadioStation> {
    const { station, favourite } = await this.record(userId, id);
    if (!favourite) {
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO radio_favourites (user_id, station_id, station, added_at) VALUES (?, ?, ?, ?)",
        )
        .run(userId, station.id, JSON.stringify(station), new Date().toISOString());
    }
    return this.#show(station, true);
  }

  removeFavourite(userId: string, id: string) {
    const { changes } = this.#db
      .prepare("DELETE FROM radio_favourites WHERE user_id = ? AND station_id = ?")
      .run(userId, id);
    if (!changes) throw notFound("Station");
  }

  add(userId: string, body: AddRadioStation): RadioStation {
    const station: StationRecord = {
      id: `custom-${newId()}`,
      name: body.name,
      streamUrl: new URL(body.streamUrl).href,
      homepage: body.homepage,
      logoUrl: null,
      country: null,
      countryCode: null,
      languages: [],
      tags: [],
      codec: null,
      bitrate: null,
      clicks: 0,
      custom: true,
    };
    this.#db
      .prepare("INSERT INTO radio_favourites (user_id, station_id, station, added_at) VALUES (?, ?, ?, ?)")
      .run(userId, station.id, JSON.stringify(station), new Date().toISOString());
    return this.#show(station, true);
  }

  countries(): Promise<{ items: RadioFacet[] }> {
    return this.directory.countries().then((items) => ({ items }), unavailable);
  }

  languages(): Promise<{ items: RadioFacet[] }> {
    return this.directory.languages().then((items) => ({ items }), unavailable);
  }

  tags(limit: number): Promise<{ items: RadioFacet[] }> {
    return this.directory.tags(limit).then((items) => ({ items }), unavailable);
  }

  /** The station's logo as WebP of at most `size` pixels, or null when it has none to be had. */
  async logo(userId: string, id: string, size: number): Promise<Buffer | null> {
    const { station } = await this.record(userId, id);
    if (!station.logoUrl) return null;
    const path = await this.#storedLogo(station.logoUrl);
    if (!path) return null;
    return sharp(path)
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  }

  /**
   * A station's live audio for the caller, until `signal` aborts (the player goes away).
   * Resolves once the audio is coming, so a station that's down is an error response.
   */
  async stream(
    userId: string,
    id: string,
    query: LiveQuery,
    signal: AbortSignal,
  ): Promise<{ stream: Readable; mime: string }> {
    const { station } = await this.record(userId, id);
    const opts = {
      // A station a user added may well be on their own network; the directory's may not.
      allowPrivate: station.custom,
      userAgent: this.#userAgent,
      signal,
    };
    const failed = (err: unknown): never => {
      if (signal.aborted) throw new HttpError(499, "closed", "The player went away");
      if (err instanceof StationUnavailable || err instanceof Refused || err instanceof TranscodeError) {
        throw new HttpError(502, "station_unavailable", err.message);
      }
      if (err instanceof Error && (err.name === "TimeoutError" || err instanceof TypeError)) {
        throw new HttpError(502, "station_unavailable", "The station can't be reached");
      }
      throw err;
    };
    const upstream = await connect(this.#fetch, station.streamUrl, opts).catch(failed);

    const live = this.#live.get(station.id) ?? { listeners: 0, title: null };
    live.listeners++;
    this.#live.set(station.id, live);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (--live.listeners === 0) this.#live.delete(station.id);
    };
    signal.addEventListener("abort", end, { once: true });
    const onTitle = (title: string | null) => {
      live.title = title;
    };

    try {
      let result: { stream: Readable; mime: string };
      if (upstream.kind === "fetched") {
        const audio = liveAudio(
          upstream,
          () => connect(this.#fetch, station.streamUrl, opts),
          signal,
          onTitle,
        );
        if (upstream.codec && query.direct.includes(upstream.codec)) {
          result = { stream: audio, mime: upstream.mime };
        } else {
          const t = await transcode(this.#ffmpeg, audio, query.format, query.bitrate, undefined, {
            firstBytesMs: FIRST_AUDIO_MS,
          });
          signal.addEventListener("abort", t.kill, { once: true });
          result = { stream: t.stream, mime: t.mime };
        }
      } else {
        const t = await transcode(this.#ffmpeg, upstream.url, query.format, query.bitrate, undefined, {
          inputArgs: [...FFMPEG_LIVE_INPUT, "-user_agent", this.#userAgent],
          firstBytesMs: FIRST_AUDIO_MS,
        });
        signal.addEventListener("abort", t.kill, { once: true });
        result = { stream: t.stream, mime: t.mime };
      }
      result.stream.once("close", end);
      this.#click(userId, station);
      return result;
    } catch (err) {
      end();
      return failed(err);
    }
  }

  /** Tells the directory the station was played: its popularity is made of these. */
  #click(userId: string, station: StationRecord) {
    if (station.custom) return;
    const key = `${userId}:${station.id}`;
    const now = Date.now();
    if ((this.#clicked.get(key) ?? 0) > now) return;
    this.#clicked.set(key, now + CLICK_INTERVAL_MS);
    for (const [k, until] of this.#clicked) if (until <= now) this.#clicked.delete(k);
    void this.directory.click(station.id).catch(() => {});
  }

  nowPlaying(userId: string, id: string): RadioNowPlaying {
    // Someone else's station stays theirs.
    if (id.startsWith("custom-") && !this.#favourites(userId).has(id)) throw notFound("Station");
    const title = this.#live.get(id)?.title ?? null;
    const dash = title?.indexOf(" - ") ?? -1;
    const artist = title && dash > 0 ? title.slice(0, dash).trim() : "";
    const song = title && dash > 0 ? title.slice(dash + 3).trim() : "";
    return {
      title,
      artist: artist && song ? artist : null,
      song: artist && song ? song : null,
    };
  }

  /** The logo fetched once and kept on disk (shared by stations with the same address). */
  #storedLogo(url: string): Promise<string | null> {
    const path = join(this.#logoDir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.webp`);
    const loading = this.#logoLoading.get(path);
    if (loading) return loading;
    const load = (async () => {
      try {
        await readFile(path);
        return path;
      } catch {
        // Not fetched yet.
      }
      if ((this.#logoFailed.get(url) ?? 0) > Date.now()) return null;
      try {
        const data = await this.#download(url);
        const image = (data[0] === 0 && data[2] === 1 ? pngFromIco(data) : null) ?? data;
        const webp = await sharp(image)
          .resize(LOGO_STORED, LOGO_STORED, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();
        await mkdir(this.#logoDir, { recursive: true });
        await writeFile(path, webp);
        return path;
      } catch {
        // Gone, not an image, or one sharp can't read: the clients show a generic one.
        this.#logoFailed.set(url, Date.now() + LOGO_RETRY_MS);
        return null;
      }
    })().finally(() => this.#logoLoading.delete(path));
    this.#logoLoading.set(path, load);
    return load;
  }

  async #download(address: string): Promise<Uint8Array> {
    const { res, url } = await fetchFollowing(
      this.#fetch,
      address,
      {
        headers: { "User-Agent": this.#userAgent, Accept: "image/*" },
        signal: AbortSignal.timeout(10_000),
      },
      false,
    );
    if (!res.ok || !res.body) throw new Error(`${url.href}: ${res.status}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > LOGO_MAX_BYTES) throw new Error(`${url.href}: too large`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseFile, type IAudioMetadata } from "music-metadata";
import type { Db } from "../db.ts";
import type { ArtworkStore } from "./artwork.ts";
import { rebuildSearchIndex } from "../catalog/searchIndex.ts";
import { creditsFromTags } from "./tagCredits.ts";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".ogg",
  ".opus",
  ".m4a",
  ".aac",
  ".wav",
  ".aiff",
  ".aif",
  ".wv",
  ".ape",
  ".mpc",
]);
const FOLDER_COVERS = ["cover", "folder", "front", "album"];
const IMAGE_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Bumped when the way metadata maps to the catalog changes; a mismatch makes the
 * next scan re-read every file instead of skipping unchanged ones.
 */
const SCAN_VERSION = "2";

export const stableId = (...parts: string[]) =>
  createHash("sha1").update(parts.join("\u0000").toLowerCase()).digest("hex").slice(0, 16);

export interface ScanStats {
  scanned: number;
  updated: number;
  removed: number;
  errors: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) yield path;
  }
}

export class Scanner {
  readonly #db: Db;
  readonly #artwork: ArtworkStore;
  /** Folder cover lookups, cached per directory for the duration of a scan. */
  #folderCovers = new Map<string, Promise<string | null>>();

  constructor(db: Db, artwork: ArtworkStore) {
    this.#db = db;
    this.#artwork = artwork;
  }

  async scan(root: string): Promise<ScanStats> {
    const db = this.#db;
    // A missing root is far more likely an unmounted network share than a deleted library:
    // refuse to scan rather than remove every track (and empty queues along with them).
    const rootStat = await stat(root).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error(`library folder ${root} is not available`);
    const generation =
      Number(
        (db.prepare("SELECT value FROM meta WHERE key = 'scan_generation'").get()?.value as string) ?? 0,
      ) + 1;
    const stats: ScanStats = { scanned: 0, updated: 0, removed: 0, errors: 0 };
    const rescanAll =
      (db.prepare("SELECT value FROM meta WHERE key = 'scan_version'").get()?.value as string | undefined) !==
      SCAN_VERSION;
    const existing = db.prepare("SELECT mtime_ms FROM tracks WHERE path = ?");
    const markSeen = db.prepare("UPDATE tracks SET seen_scan = ? WHERE path = ?");
    this.#folderCovers.clear();

    for await (const path of walk(root)) {
      stats.scanned++;
      try {
        const { mtimeMs, size } = await stat(path);
        const row = existing.get(path) as { mtime_ms: number } | undefined;
        if (!rescanAll && row && row.mtime_ms === Math.trunc(mtimeMs)) {
          markSeen.run(generation, path);
          continue;
        }
        const meta = await parseFile(path, { duration: true });
        await this.#upsert(path, Math.trunc(mtimeMs), size, meta, generation);
        stats.updated++;
      } catch (err) {
        stats.errors++;
        console.warn(`scan: skipping ${path}: ${(err as Error).message}`);
      }
    }

    db.exec("BEGIN");
    try {
      const known = Number((db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n);
      if (stats.scanned === 0 && known > 0) {
        // Same reasoning for a root that exists but reads as empty (e.g. a mount point without its share).
        console.warn(`scan: ${root} contains no audio but the library has ${known} tracks; keeping them`);
      } else {
        stats.removed = Number(db.prepare("DELETE FROM tracks WHERE seen_scan <> ?").run(generation).changes);
      }
      db.exec("DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM tracks)");
      db.exec(`DELETE FROM artists WHERE id NOT IN (SELECT artist_id FROM tracks)
                                     AND id NOT IN (SELECT artist_id FROM albums)`);
      db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('scan_generation', ?), ('last_scan_at', ?), ('scan_version', ?)",
      ).run(String(generation), new Date().toISOString(), SCAN_VERSION);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    rebuildSearchIndex(db);
    return stats;
  }

  async #upsert(path: string, mtimeMs: number, size: number, meta: IAudioMetadata, generation: number) {
    const { common, format } = meta;
    // The full credit as tagged ("A feat. B"), shown on the track.
    const artistCredit = common.artist?.trim() || "Unknown Artist";
    const albumArtistCredit = common.albumartist?.trim() || artistCredit;
    const albumTitle = common.album?.trim() || "Unknown Album";
    const title = common.title?.trim() || basename(path, extname(path));

    // Artists are keyed by MusicBrainz id when tagged, so differently spelled credits
    // ("Miles Davis Quintet" vs. a mislabelled compilation name) can't fork or merge identities
    // by accident. Enrichment later replaces the name with MusicBrainz's canonical one.
    const trackMbid = common.musicbrainz_artistid?.[0] ?? null;
    const albumMbid =
      common.musicbrainz_albumartistid?.[0] ?? (albumArtistCredit === artistCredit ? trackMbid : null);
    const trackArtist = (trackMbid && common.artists?.[0]?.trim()) || artistCredit;
    const albumArtist = (albumMbid && common.albumartists?.[0]?.trim()) || albumArtistCredit;
    const artistKey = (mbid: string | null, name: string) =>
      mbid ? stableId("artist-mbid", mbid) : stableId("artist", name);
    const albumArtistId = artistKey(albumMbid, albumArtist);
    const trackArtistId = artistKey(trackMbid, trackArtist);
    const albumId = stableId("album", albumArtistId, albumTitle);
    const trackId = stableId("track", path);
    // Prefer the original release year: reissues otherwise date a 1959 album to 2013.
    const year = common.originalyear ?? common.year ?? null;

    const picture =
      common.picture?.find((p) => p.type?.toLowerCase().includes("front")) ?? common.picture?.[0];
    const coverId = picture
      ? await this.#artwork.put(picture.data, picture.format)
      : await this.#folderCover(dirname(path));

    const db = this.#db;
    const upsertArtist = db.prepare(`
      INSERT INTO artists (id, name, sort_name, musicbrainz_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET musicbrainz_id = COALESCE(artists.musicbrainz_id, excluded.musicbrainz_id)`);
    upsertArtist.run(albumArtistId, albumArtist, common.albumartistsort || albumArtist, albumMbid);
    if (trackArtistId !== albumArtistId) {
      upsertArtist.run(trackArtistId, trackArtist, common.artistsort || trackArtist, trackMbid);
    }

    db.prepare(`
      INSERT INTO albums (id, title, artist_id, year, cover_id, added_at, musicbrainz_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET year = COALESCE(excluded.year, albums.year),
                                    cover_id = COALESCE(albums.cover_id, excluded.cover_id),
                                    musicbrainz_id = COALESCE(excluded.musicbrainz_id, albums.musicbrainz_id),
                                    -- A changed file may change credits: enrich the album again.
                                    enrich_status = NULL`).run(
      albumId,
      albumTitle,
      albumArtistId,
      year,
      coverId,
      new Date().toISOString(),
      common.musicbrainz_albumid ?? null,
    );

    // Upsert rather than REPLACE: a REPLACE would cascade-delete the track's MusicBrainz credits.
    db.prepare(`
      INSERT INTO tracks (
        id, path, mtime_ms, title, artist_id, album_id, track_number, disc_number, year, duration_ms, genres,
        codec, container, lossless, bitrate, sample_rate, bit_depth, channels, file_size, cover_id, seen_scan,
        musicbrainz_recording_id, artist_credit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mtime_ms = excluded.mtime_ms, title = excluded.title, artist_id = excluded.artist_id,
        album_id = excluded.album_id, track_number = excluded.track_number, disc_number = excluded.disc_number,
        year = excluded.year, duration_ms = excluded.duration_ms, genres = excluded.genres, codec = excluded.codec,
        container = excluded.container, lossless = excluded.lossless, bitrate = excluded.bitrate,
        sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth, channels = excluded.channels,
        file_size = excluded.file_size, cover_id = excluded.cover_id, seen_scan = excluded.seen_scan,
        musicbrainz_recording_id = excluded.musicbrainz_recording_id, artist_credit = excluded.artist_credit`).run(
      trackId,
      path,
      mtimeMs,
      title,
      trackArtistId,
      albumId,
      common.track.no ?? null,
      common.disk.no ?? null,
      year,
      Math.round((format.duration ?? 0) * 1000),
      JSON.stringify(common.genre ?? []),
      format.codec ?? "unknown",
      format.container ?? extname(path).slice(1),
      format.lossless ? 1 : 0,
      format.bitrate ? Math.round(format.bitrate) : null,
      format.sampleRate ?? null,
      format.bitsPerSample ?? null,
      format.numberOfChannels ?? null,
      size,
      coverId,
      generation,
      common.musicbrainz_recordingid ?? null,
      artistCredit,
    );

    db.prepare("DELETE FROM credits WHERE track_id = ? AND source = 'tags'").run(trackId);
    const insertCredit = db.prepare(`
      INSERT INTO credits (track_id, source, scope, category, name, musicbrainz_id, role, position)
      VALUES (?, 'tags', 'track', ?, ?, ?, ?, ?)`);
    creditsFromTags(meta).forEach((c, i) =>
      insertCredit.run(trackId, c.category, c.name, c.musicbrainzId, c.role, i),
    );
  }

  #folderCover(dir: string): Promise<string | null> {
    let pending = this.#folderCovers.get(dir);
    if (!pending) {
      pending = (async () => {
        const files = await readdir(dir).catch(() => [] as string[]);
        const match = files.find((f) => {
          const ext = extname(f).toLowerCase();
          return ext in IMAGE_EXTENSIONS && FOLDER_COVERS.includes(basename(f, extname(f)).toLowerCase());
        });
        if (!match) return null;
        return this.#artwork.put(
          await readFile(join(dir, match)),
          IMAGE_EXTENSIONS[extname(match).toLowerCase()]!,
        );
      })();
      this.#folderCovers.set(dir, pending);
    }
    return pending;
  }
}

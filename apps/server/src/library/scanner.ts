import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { parseFile, type IAudioMetadata } from "music-metadata";
import type { Db } from "../db.ts";
import type { ArtworkStore } from "./artwork.ts";
import { rebuildSearchIndex } from "../catalog/searchIndex.ts";
import { creditsFromTags } from "./tagCredits.ts";
import { deleteOrphans, writeTrack } from "./tracks.ts";

export { stableId } from "./tracks.ts";

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
const SCAN_VERSION = "3"; // 3: ReplayGain

export interface ScanStats {
  scanned: number;
  updated: number;
  removed: number;
  errors: number;
  /** Files changed so recently they may still be being written: left for the next scan. */
  unsettled: number;
  /** Folders that were missing or read as empty, whose tracks were kept. */
  unavailable: string[];
  /** Stopped before the end: what was read stays, nothing is removed. */
  cancelled: boolean;
}

/** How far a running scan has got: listing the folders' files, then reading them. */
export interface ScanProgress {
  phase: "listing" | "reading";
  /** Files read so far (0 while listing). */
  done: number;
  /** Files found so far while listing; all of them once reading. */
  total: number;
}

/** A file modified more recently than this may still be being copied in. */
export const SETTLE_MS = 5_000;
/** Modification times this far ahead of our clock come from a server whose clock differs. */
const CLOCK_SKEW_MS = 60_000;

/** Whether `path` is `root` or inside it. */
const inside = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

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

  readonly #settleMs: number;
  #progress: ScanProgress | null = null;
  #cancelled = false;

  constructor(db: Db, artwork: ArtworkStore, opts: { settleMs?: number } = {}) {
    this.#db = db;
    this.#artwork = artwork;
    this.#settleMs = opts.settleMs ?? SETTLE_MS;
  }

  /** The running scan's progress; null between scans. */
  get progress(): ScanProgress | null {
    return this.#progress && { ...this.#progress };
  }

  /**
   * Brings the catalog in line with the files under `roots`: adds and updates
   * changed files (by mtime) and removes tracks whose files are gone.
   */
  async scan(roots: string[]): Promise<ScanStats> {
    this.#progress = { phase: "listing", done: 0, total: 0 };
    this.#cancelled = false;
    try {
      return await this.#scan(roots);
    } finally {
      this.#progress = null;
    }
  }

  /** Stops the running scan after the file it's on. */
  cancel() {
    if (this.#progress) this.#cancelled = true;
  }

  async #scan(roots: string[]): Promise<ScanStats> {
    const progress = this.#progress!;
    const db = this.#db;
    const generation =
      Number(
        (db.prepare("SELECT value FROM meta WHERE key = 'scan_generation'").get()?.value as string) ?? 0,
      ) + 1;
    const stats: ScanStats = {
      scanned: 0,
      updated: 0,
      removed: 0,
      errors: 0,
      unsettled: 0,
      unavailable: [],
      cancelled: false,
    };
    const rescanAll =
      (db.prepare("SELECT value FROM meta WHERE key = 'scan_version'").get()?.value as string | undefined) !==
      SCAN_VERSION;
    const existing = db.prepare("SELECT mtime_ms FROM tracks WHERE path = ?");
    const markSeen = db.prepare("UPDATE tracks SET seen_scan = ? WHERE path = ?");
    // A server's tracks (a standalone player's sources) are synced, not scanned.
    const knownPaths = db.prepare("SELECT path FROM tracks WHERE source_id IS NULL");
    this.#folderCovers.clear();

    // Every file first, so the reading can report how far it has got.
    const files = new Map<string, string[]>();
    for (const root of roots) {
      const paths: string[] = [];
      if ((await stat(root).catch(() => null))?.isDirectory()) {
        for await (const path of walk(root)) {
          if (this.#cancelled) break;
          paths.push(path);
          progress.total++;
        }
      }
      files.set(root, paths);
    }
    progress.phase = "reading";

    for (const root of roots) {
      const paths = files.get(root)!;
      const found = paths.length;
      for (const path of paths) {
        if (this.#cancelled) break;
        progress.done++;
        stats.scanned++;
        try {
          const { mtimeMs, size } = await stat(path);
          const row = existing.get(path) as { mtime_ms: number } | undefined;
          if (!rescanAll && row && row.mtime_ms === Math.trunc(mtimeMs)) {
            markSeen.run(generation, path);
            continue;
          }
          // A time well in the future means the share's clock is ahead: waiting would only delay the file.
          const age = Date.now() - mtimeMs;
          if (this.#settleMs > 0 && age < this.#settleMs && age > -CLOCK_SKEW_MS) {
            // Possibly still being written: keep any previous version and look again next time.
            if (row) markSeen.run(generation, path);
            stats.unsettled++;
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
      // A missing folder is far more likely an unmounted network share than a deleted
      // library: keep its tracks (and the queues and playlists using them) rather than
      // removing them all. Same for one that exists but reads as empty (a mount point
      // without its share), as long as tracks from it are known.
      const hadTracks = () => (knownPaths.all() as { path: string }[]).some((r) => inside(root, r.path));
      if (found === 0 && hadTracks()) {
        console.warn(`scan: ${root} is missing or empty but the library has tracks from it; keeping them`);
        stats.unavailable.push(root);
      }
    }
    if (this.#cancelled) {
      // Unseen isn't gone when the scan stopped early: remove nothing, keep what was read.
      stats.cancelled = true;
      if (stats.updated) rebuildSearchIndex(db);
      return stats;
    }
    if (stats.unavailable.length === roots.length && roots.length > 0) {
      throw new Error(`no library folder is available (${roots.join(", ")})`);
    }

    db.exec("BEGIN");
    try {
      const stale = (
        db
          .prepare("SELECT id, path FROM tracks WHERE seen_scan <> ? AND source_id IS NULL")
          .all(generation) as { id: string; path: string }[]
      ).filter((r) => !stats.unavailable.some((root) => inside(root, r.path)));
      const remove = db.prepare("DELETE FROM tracks WHERE id = ?");
      // Remembered for /api/sync, so other libraries copying this one drop them too.
      const tombstone = db.prepare("INSERT OR REPLACE INTO removed_tracks (id, rev) VALUES (?, ?)");
      for (const { id } of stale) {
        remove.run(id);
        tombstone.run(id, generation);
      }
      stats.removed = stale.length;
      // Tracks kept from unavailable folders count as seen, so the next scan starts clean.
      db.prepare("UPDATE tracks SET seen_scan = ? WHERE seen_scan <> ?").run(generation, generation);
      deleteOrphans(db);
      db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('scan_generation', ?), ('last_scan_at', ?), ('scan_version', ?)",
      ).run(String(generation), new Date().toISOString(), SCAN_VERSION);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // The index covers the whole catalog: rebuild it only when the catalog changed.
    if (stats.updated || stats.removed || rescanAll) rebuildSearchIndex(db);
    return stats;
  }

  async #upsert(path: string, mtimeMs: number, size: number, meta: IAudioMetadata, generation: number) {
    const { common, format } = meta;
    const artistCredit = common.artist?.trim() || "Unknown Artist";
    const albumArtistCredit = common.albumartist?.trim() || artistCredit;
    const trackMbid = common.musicbrainz_artistid?.[0] ?? null;
    const albumMbid =
      common.musicbrainz_albumartistid?.[0] ?? (albumArtistCredit === artistCredit ? trackMbid : null);
    const trackArtist = (trackMbid && common.artists?.[0]?.trim()) || artistCredit;
    const albumArtist = (albumMbid && common.albumartists?.[0]?.trim()) || albumArtistCredit;
    // Prefer the original release year: reissues otherwise date a 1959 album to 2013.
    const year = common.originalyear ?? common.year ?? null;

    const picture =
      common.picture?.find((p) => p.type?.toLowerCase().includes("front")) ?? common.picture?.[0];
    const coverId = picture
      ? await this.#artwork.put(picture.data, picture.format)
      : await this.#folderCover(dirname(path));

    writeTrack(this.#db, {
      path,
      mtimeMs,
      size,
      title: common.title?.trim() || basename(path, extname(path)),
      artistCredit,
      artist: { name: trackArtist, sortName: common.artistsort || trackArtist, musicbrainzId: trackMbid },
      albumArtist: {
        name: albumArtist,
        sortName: common.albumartistsort || albumArtist,
        musicbrainzId: albumMbid,
      },
      album: {
        title: common.album?.trim() || "Unknown Album",
        year,
        musicbrainzId: common.musicbrainz_albumid ?? null,
      },
      trackNumber: common.track.no ?? null,
      discNumber: common.disk.no ?? null,
      year,
      durationMs: Math.round((format.duration ?? 0) * 1000),
      genres: common.genre ?? [],
      codec: format.codec ?? "unknown",
      container: format.container ?? extname(path).slice(1),
      lossless: Boolean(format.lossless),
      bitrate: format.bitrate ? Math.round(format.bitrate) : null,
      sampleRate: format.sampleRate ?? null,
      bitDepth: format.bitsPerSample ?? null,
      channels: format.numberOfChannels ?? null,
      coverId,
      recordingId: common.musicbrainz_recordingid ?? null,
      // Gains are stored in dB, peaks as linear amplitude.
      rgTrackGain: common.replaygain_track_gain?.dB ?? null,
      rgTrackPeak: common.replaygain_track_peak?.ratio ?? null,
      rgAlbumGain: common.replaygain_album_gain?.dB ?? null,
      rgAlbumPeak: common.replaygain_album_peak?.ratio ?? null,
      credits: creditsFromTags(meta),
      rev: generation,
      seenScan: generation,
      source: null,
    });
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

import { randomUUID } from "node:crypto";
import type { CreditCategory, SyncPage, SyncTrack } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";

type Row = Record<string, unknown>;

const num = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? null : (v as string));

/** This library's id, made on first use: a new database is a new library to whoever copies it. */
export function libraryId(db: Db): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'library_id'").get() as Row | undefined;
  if (row) return String(row.value);
  const id = randomUUID();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('library_id', ?)").run(id);
  return String((db.prepare("SELECT value FROM meta WHERE key = 'library_id'").get() as Row).value);
}

/** The last finished scan: every track written by a later (running) one is listed again next time. */
function revision(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'scan_generation'").get() as Row | undefined;
  return row ? Number(row.value) : 0;
}

const SELECT = `
  SELECT t.*, ta.name AS ta_name, ta.sort_name AS ta_sort, ta.musicbrainz_id AS ta_mbid,
         aa.name AS aa_name, aa.sort_name AS aa_sort, aa.musicbrainz_id AS aa_mbid,
         al.title AS al_title, al.year AS al_year, al.musicbrainz_id AS al_mbid, al.added_at AS al_added,
         c.id AS c_id, c.mime AS c_mime, c.width AS c_width, c.height AS c_height, c.dominant_color AS c_color
  FROM all_tracks t
  JOIN artists ta ON ta.id = t.artist_id
  JOIN albums al ON al.id = t.album_id
  JOIN artists aa ON aa.id = al.artist_id
  LEFT JOIN artwork c ON c.id = COALESCE(t.cover_id, al.cover_id)`;

/**
 * A page of the catalog for another library to copy (a standalone player's engine): every
 * track, or with `since` only those written by later scans, plus the ones removed since.
 * Only this library's own files are listed, never tracks it copied from elsewhere.
 */
export function syncPage(db: Db, q: { since: number; after?: string; limit: number }): SyncPage {
  const rev = revision(db);
  // A revision from the future: this library was restored from an older copy. Start over.
  const full = q.since === 0 || q.since > rev;
  const rows = db
    .prepare(
      `${SELECT} WHERE t.source_id IS NULL AND t.id > ? ${full ? "" : "AND t.rev > ?"}
       ORDER BY t.id LIMIT ?`,
    )
    .all(...(full ? [q.after ?? "", q.limit] : [q.after ?? "", q.since, q.limit])) as Row[];
  const credits = db.prepare(
    "SELECT name, role, category, musicbrainz_id FROM credits WHERE track_id = ? AND source = 'tags' ORDER BY position",
  );
  const tracks = rows.map((r): SyncTrack => {
    const albumAddedAt = String(r.al_added);
    return {
      id: String(r.id),
      title: String(r.title),
      artistCredit: str(r.artist_credit) ?? String(r.ta_name),
      artist: { name: String(r.ta_name), sortName: String(r.ta_sort), musicbrainzId: str(r.ta_mbid) },
      albumArtist: { name: String(r.aa_name), sortName: String(r.aa_sort), musicbrainzId: str(r.aa_mbid) },
      album: {
        title: String(r.al_title),
        year: num(r.al_year),
        musicbrainzId: str(r.al_mbid),
        addedAt: Number.isNaN(Date.parse(albumAddedAt)) ? new Date(0).toISOString() : albumAddedAt,
      },
      trackNumber: num(r.track_number),
      discNumber: num(r.disc_number),
      year: num(r.year),
      durationMs: Number(r.duration_ms),
      genres: JSON.parse(String(r.genres)) as string[],
      format: {
        codec: String(r.codec),
        container: String(r.container),
        lossless: Boolean(r.lossless),
        bitrate: num(r.bitrate),
        sampleRate: num(r.sample_rate),
        bitDepth: num(r.bit_depth),
        channels: num(r.channels),
      },
      replayGain: {
        trackGain: num(r.rg_track_gain),
        trackPeak: num(r.rg_track_peak),
        albumGain: num(r.rg_album_gain),
        albumPeak: num(r.rg_album_peak),
      },
      fileSize: Number(r.file_size),
      modifiedMs: Number(r.mtime_ms),
      musicbrainzRecordingId: str(r.musicbrainz_recording_id),
      cover:
        r.c_id == null
          ? null
          : {
              id: r.c_id as string,
              mime: String(r.c_mime),
              width: num(r.c_width),
              height: num(r.c_height),
              dominantColor: str(r.c_color),
            },
      credits: (credits.all(r.id as string) as Row[]).map((c) => ({
        name: String(c.name),
        role: String(c.role),
        category: c.category as CreditCategory,
        musicbrainzId: str(c.musicbrainz_id),
      })),
    };
  });
  const removed =
    full || q.after
      ? []
      : (db.prepare("SELECT id FROM removed_tracks WHERE rev > ? ORDER BY id").all(q.since) as Row[]).map(
          (r) => String(r.id),
        );
  return {
    libraryId: libraryId(db),
    revision: rev,
    full,
    tracks,
    removed,
    next: tracks.length === q.limit ? tracks[tracks.length - 1]!.id : null,
  };
}

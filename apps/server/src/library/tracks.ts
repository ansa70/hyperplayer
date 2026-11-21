import { createHash } from "node:crypto";
import type { Db } from "../db.ts";
import type { CreditRow } from "./tagCredits.ts";
import { reapplyEdits } from "./edits.ts";

export const stableId = (...parts: string[]) =>
  createHash("sha1").update(parts.join("\u0000").toLowerCase()).digest("hex").slice(0, 16);

export interface ArtistRecord {
  name: string;
  sortName: string;
  musicbrainzId: string | null;
}

/** A track as the catalog stores it, read from a file's tags or copied from a server. */
export interface TrackRecord {
  /** The file's path, or for a server's track a made-up one (see `remotePath`). */
  path: string;
  mtimeMs: number;
  size: number;
  title: string;
  /** The full credit as tagged ("A feat. B"), shown on the track. */
  artistCredit: string;
  artist: ArtistRecord;
  albumArtist: ArtistRecord;
  album: { title: string; year: number | null; musicbrainzId: string | null; addedAt?: string };
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  durationMs: number;
  genres: string[];
  codec: string;
  container: string;
  lossless: boolean;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  coverId: string | null;
  recordingId: string | null;
  rgTrackGain: number | null;
  rgTrackPeak: number | null;
  rgAlbumGain: number | null;
  rgAlbumPeak: number | null;
  credits: CreditRow[];
  /** The scan that wrote it (this library's files), or null. */
  rev: number | null;
  seenScan: number;
  source: { id: string; remoteId: string } | null;
  /** An upload's owner (only they see it); null or absent for the shared library. */
  owner?: string | null;
}

/** The path a server's track is stored under: unique, and never a file on this computer. */
export const remotePath = (sourceId: string, remoteId: string) => `hp-source:${sourceId}/${remoteId}`;

/**
 * Artists are keyed by MusicBrainz id when tagged, so differently spelled credits ("Miles
 * Davis Quintet" vs. a mislabelled compilation name) can't fork or merge identities by
 * accident. The same artist from a server and from this computer's files is one artist.
 */
const artistId = (a: ArtistRecord) =>
  a.musicbrainzId ? stableId("artist-mbid", a.musicbrainzId) : stableId("artist", a.name);

/** Adds or updates a track, with its artists, album and tag credits. Returns its id. */
export function writeTrack(db: Db, t: TrackRecord): string {
  const albumArtistId = artistId(t.albumArtist);
  const trackArtistId = artistId(t.artist);
  const albumId = stableId("album", albumArtistId, t.album.title);
  const trackId = stableId("track", t.path);

  const upsertArtist = db.prepare(`
    INSERT INTO artists (id, name, sort_name, musicbrainz_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET musicbrainz_id = COALESCE(artists.musicbrainz_id, excluded.musicbrainz_id)`);
  upsertArtist.run(albumArtistId, t.albumArtist.name, t.albumArtist.sortName, t.albumArtist.musicbrainzId);
  if (trackArtistId !== albumArtistId) {
    upsertArtist.run(trackArtistId, t.artist.name, t.artist.sortName, t.artist.musicbrainzId);
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
    t.album.title,
    albumArtistId,
    t.album.year,
    t.coverId,
    t.album.addedAt ?? new Date().toISOString(),
    t.album.musicbrainzId,
  );

  // Upsert rather than REPLACE: a REPLACE would cascade-delete the track's MusicBrainz credits.
  db.prepare(`
    INSERT INTO all_tracks (
      id, path, mtime_ms, title, artist_id, album_id, track_number, disc_number, year, duration_ms, genres,
      codec, container, lossless, bitrate, sample_rate, bit_depth, channels, file_size, cover_id, seen_scan,
      musicbrainz_recording_id, artist_credit, rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak,
      rev, source_id, remote_id, owner_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mtime_ms = excluded.mtime_ms, title = excluded.title, artist_id = excluded.artist_id,
      album_id = excluded.album_id, track_number = excluded.track_number, disc_number = excluded.disc_number,
      year = excluded.year, duration_ms = excluded.duration_ms, genres = excluded.genres, codec = excluded.codec,
      container = excluded.container, lossless = excluded.lossless, bitrate = excluded.bitrate,
      sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth, channels = excluded.channels,
      file_size = excluded.file_size, cover_id = excluded.cover_id, seen_scan = excluded.seen_scan,
      musicbrainz_recording_id = excluded.musicbrainz_recording_id, artist_credit = excluded.artist_credit,
      rg_track_gain = excluded.rg_track_gain, rg_track_peak = excluded.rg_track_peak,
      rg_album_gain = excluded.rg_album_gain, rg_album_peak = excluded.rg_album_peak,
      rev = excluded.rev, source_id = excluded.source_id, remote_id = excluded.remote_id,
      owner_id = excluded.owner_id`).run(
    trackId,
    t.path,
    t.mtimeMs,
    t.title,
    trackArtistId,
    albumId,
    t.trackNumber,
    t.discNumber,
    t.year,
    t.durationMs,
    JSON.stringify(t.genres),
    t.codec,
    t.container,
    t.lossless ? 1 : 0,
    t.bitrate,
    t.sampleRate,
    t.bitDepth,
    t.channels,
    t.size,
    t.coverId,
    t.seenScan,
    t.recordingId,
    t.artistCredit,
    t.rgTrackGain,
    t.rgTrackPeak,
    t.rgAlbumGain,
    t.rgAlbumPeak,
    t.rev,
    t.source?.id ?? null,
    t.source?.remoteId ?? null,
    t.owner ?? null,
  );

  db.prepare("DELETE FROM credits WHERE track_id = ? AND source = 'tags'").run(trackId);
  const insertCredit = db.prepare(`
    INSERT INTO credits (track_id, source, scope, category, name, musicbrainz_id, role, position)
    VALUES (?, 'tags', 'track', ?, ?, ?, ?, ?)`);
  t.credits.forEach((c, i) => insertCredit.run(trackId, c.category, c.name, c.musicbrainzId, c.role, i));
  // Tags edited in HyperPlayer go back over the file's.
  reapplyEdits(db, trackId);
  return trackId;
}

/** Removes albums and artists no track (or album) refers to anymore. */
export function deleteOrphans(db: Db) {
  db.exec("DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM all_tracks)");
  db.exec(`DELETE FROM artists WHERE id NOT IN (SELECT artist_id FROM all_tracks)
                                 AND id NOT IN (SELECT artist_id FROM albums)`);
}

import type { QueueOrigin, SmartRules, TrackSource } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";
import { IN_GENRE } from "../catalog/genres.ts";
import { notFound } from "../http/contract.ts";
import { smartTracks } from "./smart.ts";

type Row = Record<string, unknown>;

export const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/** Expands a track source into track ids, in the order they should play. */
export function resolveSource(
  db: Db,
  source: TrackSource,
  userId: string,
): { trackIds: string[]; origin: QueueOrigin } {
  const ids = (sql: string, ...args: string[]) =>
    (db.prepare(sql).all(...args) as Row[]).map((r) => String(r.id));
  const name = (sql: string, id: string, what: string) => {
    const row = db.prepare(sql).get(id) as Row | undefined;
    if (!row) throw notFound(what);
    return String(row.name);
  };

  /** `trackIds` in their order, without any the library doesn't have. */
  const known = (trackIds: string[]) => {
    const found = new Set(
      ids(`SELECT id FROM tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`, ...trackIds),
    );
    return trackIds.filter((id) => found.has(id));
  };

  switch (source.kind) {
    case "tracks":
      return {
        trackIds: known(source.trackIds),
        origin: { kind: "tracks", id: null, name: null },
      };
    case "album":
      return {
        trackIds: ids(
          "SELECT id FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number, title COLLATE NOCASE",
          source.id,
        ),
        origin: {
          kind: "album",
          id: source.id,
          name: name("SELECT title AS name FROM albums WHERE id = ?", source.id, "Album"),
        },
      };
    case "artist":
      return {
        trackIds: ids(
          `SELECT t.id FROM tracks t JOIN albums al ON al.id = t.album_id
           WHERE t.artist_id = ? OR al.artist_id = ?
           ORDER BY al.year, al.title COLLATE NOCASE, t.disc_number, t.track_number`,
          source.id,
          source.id,
        ),
        origin: {
          kind: "artist",
          id: source.id,
          name: name("SELECT name FROM artists WHERE id = ?", source.id, "Artist"),
        },
      };
    case "playlist":
      // Someone else's playlist is indistinguishable from a missing one.
      const playlist = db
        .prepare("SELECT rules FROM playlists WHERE id = ? AND owner_id = ?")
        .get(source.id, userId) as Row | undefined;
      if (!playlist) throw notFound("Playlist");
      const origin = {
        kind: "playlist" as const,
        id: source.id,
        name: name("SELECT name FROM playlists WHERE id = ?", source.id, "Playlist"),
      };
      // A smart playlist plays what matches its rules now, or the tracks the client showed.
      if (playlist.rules) {
        if (source.trackIds?.length) {
          return { trackIds: known(source.trackIds), origin };
        }
        return {
          trackIds: smartTracks(db, userId, JSON.parse(playlist.rules as string) as SmartRules).trackIds,
          origin,
        };
      }
      return {
        // Entries whose file is currently missing are skipped.
        trackIds: ids(
          `SELECT e.track_id AS id FROM playlist_entries e JOIN tracks t ON t.id = e.track_id
           WHERE e.playlist_id = ? ORDER BY e.position`,
          source.id,
        ),
        origin: {
          kind: "playlist",
          id: source.id,
          name: name("SELECT name FROM playlists WHERE id = ?", source.id, "Playlist"),
        },
      };
    case "genre":
      return {
        // By artist, then each artist's albums as they came out.
        trackIds: ids(
          `SELECT t.id FROM tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id
           WHERE ${IN_GENRE}
           ORDER BY ar.sort_name COLLATE NOCASE, al.year, al.title COLLATE NOCASE, t.disc_number, t.track_number`,
          source.name,
        ),
        origin: { kind: "genre", id: null, name: source.name },
      };
  }
}

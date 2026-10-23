import type { QueueOrigin, TrackSource } from "@hyperplayer/schemas";
import type { Db } from "../db.ts";
import { notFound } from "../http/contract.ts";

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

  switch (source.kind) {
    case "tracks": {
      const known = new Set(
        ids(
          `SELECT id FROM tracks WHERE id IN (${source.trackIds.map(() => "?").join(",")})`,
          ...source.trackIds,
        ),
      );
      return {
        trackIds: source.trackIds.filter((id) => known.has(id)),
        origin: { kind: "tracks", id: null, name: null },
      };
    }
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
      if (!db.prepare("SELECT 1 FROM playlists WHERE id = ? AND owner_id = ?").get(source.id, userId)) {
        throw notFound("Playlist");
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
  }
}

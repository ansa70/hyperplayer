import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artwork (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  mime           TEXT NOT NULL,
  width          INTEGER,
  height         INTEGER,
  dominant_color TEXT
);

CREATE TABLE IF NOT EXISTS artists (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  sort_name      TEXT NOT NULL,
  musicbrainz_id TEXT,
  biography      TEXT,
  image_id       TEXT REFERENCES artwork(id),
  banner_id      TEXT REFERENCES artwork(id)
);

CREATE TABLE IF NOT EXISTS albums (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  year      INTEGER,
  cover_id  TEXT REFERENCES artwork(id),
  added_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  mtime_ms     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  artist_id    TEXT NOT NULL REFERENCES artists(id),
  album_id     TEXT NOT NULL REFERENCES albums(id),
  track_number INTEGER,
  disc_number  INTEGER,
  year         INTEGER,
  duration_ms  INTEGER NOT NULL,
  genres       TEXT NOT NULL DEFAULT '[]',
  codec        TEXT NOT NULL,
  container    TEXT NOT NULL,
  lossless     INTEGER NOT NULL,
  bitrate      INTEGER,
  sample_rate  INTEGER,
  bit_depth    INTEGER,
  channels     INTEGER,
  file_size    INTEGER NOT NULL,
  cover_id     TEXT REFERENCES artwork(id),
  seen_scan    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tracks_album  ON tracks(album_id, disc_number, track_number);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- One row per (person, role) on a track; the catalog merges roles per person.
CREATE TABLE IF NOT EXISTS credits (
  track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,             -- 'musicbrainz' | 'tags'
  scope          TEXT NOT NULL,             -- 'track' | 'album'
  category       TEXT NOT NULL,
  name           TEXT NOT NULL,
  musicbrainz_id TEXT,
  role           TEXT NOT NULL,
  position       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_track ON credits(track_id, source);
`;

/** Columns added after the first schema version, applied to existing databases. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["artists", "disambiguation", "TEXT"],
  ["artists", "kind", "TEXT"],
  ["artists", "area", "TEXT"],
  ["artists", "active_years", "TEXT"],
  ["artists", "biography_url", "TEXT"],
  ["artists", "mb_genres", "TEXT"],
  ["artists", "links", "TEXT"],
  ["artists", "members", "TEXT"],
  ["artists", "enrich_status", "TEXT"],
  ["artists", "enriched_at", "TEXT"],
  ["albums", "musicbrainz_id", "TEXT"],
  ["albums", "enrich_status", "TEXT"],
  ["albums", "enriched_at", "TEXT"],
  ["tracks", "musicbrainz_recording_id", "TEXT"],
  ["tracks", "artist_credit", "TEXT"],
];

function migrate(db: DatabaseSync) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

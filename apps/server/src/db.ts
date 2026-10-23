import { DatabaseSync } from "node:sqlite";
import { ensureSearchIndex } from "./catalog/searchIndex.ts";

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

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Entries keep a snapshot of the track, not a foreign key: a file that moves or
-- a library that is briefly unmounted must not silently empty playlists.
CREATE TABLE IF NOT EXISTS playlist_entries (
  entry_id     TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  track_id     TEXT,
  recording_id TEXT,
  title        TEXT NOT NULL,
  artist_name  TEXT NOT NULL,
  album_title  TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  added_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS playlist_entries_order ON playlist_entries(playlist_id, position);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  admin         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- One row per signed-in client. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queues (
  device_id     TEXT PRIMARY KEY,
  shuffle       INTEGER NOT NULL DEFAULT 0,
  repeat        TEXT NOT NULL DEFAULT 'off',
  current_entry TEXT,
  position_ms   INTEGER NOT NULL DEFAULT 0,
  origin_kind   TEXT,
  origin_id     TEXT,
  origin_name   TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_entries (
  device_id    TEXT NOT NULL REFERENCES queues(device_id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL,
  track_id     TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  -- Order the tracks were queued in (restored when shuffle is turned off) and play order.
  source_index INTEGER NOT NULL,
  play_index   INTEGER NOT NULL,
  PRIMARY KEY (device_id, entry_id)
);
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
  ["playlists", "owner_id", "TEXT REFERENCES users(id) ON DELETE CASCADE"],
  ["queues", "user_id", "TEXT REFERENCES users(id) ON DELETE CASCADE"],
  ["users", "must_change_password", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "full_name", "TEXT"],
  ["tracks", "rg_track_gain", "REAL"],
  ["tracks", "rg_track_peak", "REAL"],
  ["tracks", "rg_album_gain", "REAL"],
  ["tracks", "rg_album_peak", "REAL"],
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
  ensureSearchIndex(db);
  return db;
}

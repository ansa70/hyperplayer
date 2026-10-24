import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { Catalog } from "../src/catalog/catalog.ts";
import { rebuildSearchIndex, toFtsQuery } from "../src/catalog/searchIndex.ts";
import { openDb, type Db } from "../src/db.ts";

let dir: string;
let db: Db;
let catalog: Catalog;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-search-"));
  db = openDb(join(dir, "library.db"));
  db.exec(`
    INSERT INTO artists (id, name, sort_name) VALUES ('miles', 'Miles Davis', 'Davis, Miles'), ('bey', 'Beyoncé', 'Beyoncé');
    INSERT INTO albums (id, title, artist_id, added_at) VALUES
      ('kob', 'Kind of Blue', 'miles', '2026'), ('lem', 'Lemonade', 'bey', '2026'), ('sw', 'Someday My Prince Will Come', 'miles', '2026');
  `);
  const track = db.prepare(
    `INSERT INTO tracks (id, path, mtime_ms, title, artist_id, album_id, duration_ms, codec, container, lossless, file_size)
     VALUES (?, ?, 0, ?, ?, ?, 1000, 'FLAC', 'flac', 1, 1)`,
  );
  track.run("so-what", "/1", "So What", "miles", "kob");
  track.run("blue-green", "/2", "Blue in Green", "miles", "kob");
  track.run("hold-up", "/3", "Hold Up", "bey", "lem");
  track.run("someday", "/4", "Someday My Prince Will Come", "miles", "sw");
  // Tagged genres; Beyoncé's track is untagged, so her MusicBrainz genres stand in.
  db.exec(`UPDATE tracks SET genres = '["Jazz"]' WHERE artist_id = 'miles';
           UPDATE tracks SET genres = '["Jazz", "Cool Jazz"]' WHERE id = 'blue-green';
           UPDATE artists SET mb_genres = '["pop", "R&B", "100%_fun"]' WHERE id = 'bey';`);
  db.exec(`INSERT INTO credits (track_id, source, scope, category, name, role, position)
           VALUES ('so-what', 'musicbrainz', 'track', 'performance', 'John Coltrane', 'tenor saxophone', 0)`);
  rebuildSearchIndex(db);
  catalog = new Catalog(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const titles = (q: string) => {
  const r = catalog.search(q, 10);
  return {
    artists: r.artists.map((a) => a.name),
    albums: r.albums.map((a) => a.title),
    tracks: r.tracks.map((t) => t.title),
  };
};

test("every word must match, across title, artist and album", () => {
  expect(titles("miles so what").tracks).toEqual(["So What"]);
  expect(titles("kind blue").albums).toEqual(["Kind of Blue"]);
  expect(titles("kind blue").tracks).toEqual(expect.arrayContaining(["So What", "Blue in Green"]));
});

test("prefixes, case and accents are forgiven", () => {
  expect(titles("BEYONCE").artists).toEqual(["Beyoncé"]);
  expect(titles("lemo").albums).toEqual(["Lemonade"]);
});

test("a match in the name outranks a match in the context", () => {
  // "Someday" is the track's own title; the other tracks only share an artist with it.
  expect(titles("someday").tracks[0]).toBe("Someday My Prince Will Come");
  expect(titles("blue").tracks[0]).toBe("Blue in Green");
});

test("punctuation and operators in input are treated as plain words", () => {
  expect(toFtsQuery(' "so" AND (what) ')).toBe('"so"* "AND"* "what"*');
  expect(toFtsQuery("  --  ")).toBeNull();
  expect(titles("so: what?").tracks).toEqual(["So What"]);
});

test("credited musicians find the tracks they play on", () => {
  expect(titles("coltrane").tracks).toEqual(["So What"]);
  expect(titles("coltrane so").tracks).toEqual(["So What"]);
});

test("genres are found by any part of their name, those starting with it first", () => {
  expect(catalog.search("jazz", 10).genres).toEqual([
    { name: "Jazz", trackCount: 3 },
    { name: "Cool Jazz", trackCount: 1 },
  ]);
  // From the artist's genres when the file has none.
  expect(catalog.search("POP", 10).genres).toEqual([{ name: "pop", trackCount: 1 }]);
  // LIKE's wildcards are plain characters in a query.
  expect(catalog.search("100%", 10).genres.map((g) => g.name)).toEqual(["100%_fun"]);
  expect(catalog.search("_", 10).genres.map((g) => g.name)).toEqual(["100%_fun"]); // not every genre
  expect(catalog.search("%", 10).genres.map((g) => g.name)).toEqual(["100%_fun"]);
});

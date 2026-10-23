import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { z } from "zod";
import { Catalog } from "../src/catalog/catalog.ts";
import { openDb, type Db } from "../src/db.ts";
import { matchTracks, releaseCredits } from "../src/enrich/credits.ts";
import { Enricher } from "../src/enrich/enricher.ts";
import { NotFound, type HttpClient } from "../src/enrich/http.ts";
import { Release } from "../src/enrich/musicbrainz.ts";
import { ArtworkStore } from "../src/library/artwork.ts";
import { parsePerformer } from "../src/library/tagCredits.ts";
import { Wikipedia } from "../src/enrich/wikipedia.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as unknown;
const CREDITED = fixture("kind-of-blue-1987-credited.release.json");
const UNCREDITED = fixture("kind-of-blue-2013-uncredited.release.json");
const UNCREDITED_ID = "a25deb78-2bcd-4535-86b6-2c66505e796d";
const CREDITED_ID = "e32a3f0b-1c19-3170-bb1c-650893774744";

const names = (credits: { name: string; role: string }[]) => credits.map((c) => `${c.name}: ${c.role}`);

test("per-track performers and work composers from a release lookup", () => {
  const { tracks, album } = releaseCredits(Release.parse(CREDITED));
  const freddie = tracks.find((t) => t.title === "Freddie Freeloader")!;
  expect(names(freddie.credits)).toEqual(
    expect.arrayContaining([
      "Wynton Kelly: piano",
      "John Coltrane: tenor saxophone",
      "Miles Davis: composer",
    ]),
  );
  // Bill Evans plays on the rest of the album but not on this track.
  expect(names(freddie.credits)).not.toContain("Bill Evans: piano");
  const blueInGreen = tracks.find((t) => t.title === "Blue in Green")!;
  expect(blueInGreen.credits.filter((c) => c.role === "composer").map((c) => c.name)).toEqual([
    "Miles Davis",
    "Bill Evans",
  ]);
  expect(names(album)).toEqual(expect.arrayContaining(["Teo Macero: producer", "Bill Evans: liner notes"]));
});

test("tracks match by recording id, then position, then title", () => {
  const { tracks } = releaseCredits(Release.parse(CREDITED));
  const matched = matchTracks(
    [
      { id: "a", recordingId: tracks[2]!.recordingId, disc: 1, position: 9, title: "x" },
      { id: "b", recordingId: null, disc: 1, position: 2, title: "x" },
      { id: "c", recordingId: null, disc: null, position: null, title: "ALL BLUES" },
    ],
    tracks,
  );
  expect(matched.get("a")?.title).toBe("Blue in Green");
  expect(matched.get("b")?.title).toBe("Freddie Freeloader");
  expect(matched.get("c")?.title).toBe("All Blues");
});

test("parses Picard PERFORMER tags", () => {
  expect(parsePerformer("Bill Evans (piano)")).toEqual({ name: "Bill Evans", role: "piano" });
  expect(parsePerformer("Ensemble (Live) (strings)")).toEqual({ name: "Ensemble (Live)", role: "strings" });
  expect(parsePerformer("Someone")).toEqual({ name: "Someone", role: "performer" });
});

// --------------------------------------------------------------- enricher

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-enrich-"));
  db = openDb(join(dir, "library.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Serves canned responses by URL substring; anything else is a 404. */
function fakeHttp(routes: Record<string, unknown>): HttpClient & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async json<S extends z.ZodType>(url: string, schema: S) {
      requested.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) throw new NotFound(url);
      return schema.parse(hit[1]) as z.output<S>;
    },
    async bytes(url: string) {
      requested.push(url);
      throw new NotFound(url);
    },
  };
}

const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;

test("falls back to a credited edition when the library's release has no credits", async () => {
  db.exec(`
    INSERT INTO artists (id, name, sort_name, musicbrainz_id) VALUES ('miles', 'Miles Davis', 'Davis, Miles', NULL);
    INSERT INTO albums (id, title, artist_id, year, added_at, musicbrainz_id)
      VALUES ('kob', 'Kind of Blue', 'miles', 1959, '2026-01-01', '${UNCREDITED_ID}');
  `);
  const titles = ["So What", "Freddie Freeloader", "Blue in Green", "All Blues", "Flamenco Sketches"];
  titles.forEach((title, i) =>
    db
      .prepare(
        `INSERT INTO tracks (id, path, mtime_ms, title, artist_id, album_id, track_number, disc_number,
           duration_ms, codec, container, lossless, file_size)
         VALUES (?, ?, 0, ?, 'miles', 'kob', ?, 1, 1000, 'FLAC', 'flac', 1, 1)`,
      )
      .run(`t${i + 1}`, `/m/${i}.flac`, title, i + 1),
  );

  const uncredited = { ...(UNCREDITED as object), "release-group": { id: "rg" } };
  const http = fakeHttp({
    [`/release/${UNCREDITED_ID}`]: uncredited,
    [`/release/${CREDITED_ID}`]: CREDITED,
    "release-group=rg": {
      releases: [
        { id: "promo", date: "1959", status: "Promotion", media: [{ "track-count": 5 }] },
        { id: CREDITED_ID, date: "1987", status: "Official", media: [{ "track-count": 5 }] },
      ],
    },
  });
  const enricher = new Enricher(
    db,
    new ArtworkStore(db, dir),
    silent,
    { enabled: true, contact: "test", wikiLang: "en", fanartKey: null },
    http,
  );
  enricher.enqueuePending();
  await expect.poll(() => enricher.queueSize, { timeout: 5000 }).toBe(0);

  const catalog = new Catalog(db, enricher);
  const credits = catalog.trackCredits("t2")!;
  expect(credits.enrichment).toBe("done");
  const performers = credits.credits.filter((c) => c.category === "performance");
  expect(performers.map((c) => `${c.name}: ${c.roles.join(", ")}`)).toContain("Wynton Kelly: piano");
  expect(credits.credits.find((c) => c.name === "Teo Macero")).toMatchObject({
    scope: "album",
    category: "production",
  });
  // Miles is the album artist in the library, so his credit links to the local artist page.
  expect(performers.find((c) => c.name === "Miles Davis")?.artistId).toBe("miles");
  // The library keeps pointing at its own edition.
  expect(
    (db.prepare("SELECT musicbrainz_id FROM albums").get() as { musicbrainz_id: string }).musicbrainz_id,
  ).toBe(UNCREDITED_ID);
});

test("uses the Wikidata description when an artist has no Wikipedia article", async () => {
  const http = fakeHttp({
    "ids=Q111569483": {
      entities: {
        Q111569483: {
          sitelinks: {},
          claims: {},
          descriptions: { en: { value: "American musical group; jazz quartet led by Miles Davis" } },
        },
      },
    },
  });
  const profile = await new Wikipedia(http, "it").profile("https://www.wikidata.org/wiki/Q111569483");
  expect(profile).toEqual({
    biography: "American musical group; jazz quartet led by Miles Davis.",
    biographyUrl: "https://www.wikidata.org/wiki/Q111569483",
    imageUrl: null,
  });
});

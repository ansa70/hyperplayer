import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Playlist, PlaylistList, QueueState } from "@hyperplayer/schemas";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { authed, setupAdmin, testConfig, wav } from "./helpers.ts";

let dir: string;
let lib: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let inject: ReturnType<typeof authed>;

interface Song {
  title: string;
  seconds?: number;
  sampleRate?: number;
}

/** An album of `songs` by `artist`, from `year`, in `genre`. */
function album(artist: string, title: string, year: number, genre: string, songs: Song[]) {
  mkdirSync(join(lib, artist, title), { recursive: true });
  songs.forEach((s, i) =>
    writeFileSync(
      join(lib, artist, title, `${i + 1}.wav`),
      wav(
        { INAM: s.title, IART: artist, IPRD: title, ITRK: String(i + 1), ICRD: String(year), IGNR: genre },
        s.seconds ?? 1,
        s.sampleRate ?? 8000,
      ),
    ),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-smart-"));
  lib = join(dir, "music");
  album("Miles Davis", "Kind of Blue", 1959, "Jazz", [
    { title: "So What" },
    { title: "Blue in Green", seconds: 3 },
  ]);
  album("Miles Davis", "Bitches Brew", 1970, "Jazz Fusion", [{ title: "Spanish Key", sampleRate: 44100 }]);
  album("Aphex Twin", "Drukqs", 2001, "Electronic", [
    { title: "Avril 14th" },
    { title: "Vordhosbn", seconds: 2 },
  ]);
  album("Area", "1978", 1978, "Jazz", [
    { title: "Il bandito del deserto", seconds: 40 },
    { title: "Return", seconds: 40 },
  ]);
  ctx = await buildApp(testConfig(lib, join(dir, "data")), { logger: false });
  await ctx.startScan();
  inject = authed(ctx.app, await setupAdmin(ctx.app));
});

afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

type Rules = Record<string, unknown>;
const create = async (rules: Rules, name = "Smart") => {
  const res = await inject({ method: "POST", url: "/api/playlists", payload: { name, rules } });
  expect(res.statusCode, res.body).toBe(200);
  return Playlist.parse(res.json());
};
const titles = (p: Playlist) => p.entries.map((e) => e.track!.title);
/** The titles a rule set picks, in title order. */
const pick = async (rules: Rules) => titles(await create({ order: "title", ...rules }));
const rule = (field: string, op: string, value = "", value2 = "") => ({ field, op, value, value2 });

test("a smart playlist holds whatever matches its rules, in its order, up to its limit", async () => {
  const p = await create({ rules: [rule("genre", "is", "jazz")], order: "year", descending: true, limit: 2 });
  expect(p).toMatchObject({ matching: 4, trackCount: 2, rules: { limit: 2 } });
  expect(titles(p)).toEqual(["Il bandito del deserto", "Return"]); // 1978 before 1959
  // The sidebar's list knows it's smart, and counts what it holds.
  const list = PlaylistList.parse((await inject("/api/playlists")).json());
  expect(list[0]).toMatchObject({ trackCount: 2, rules: { order: "year" } });
});

test("text rules: contains, is, starts with and their opposites, regardless of case", async () => {
  expect(await pick({ rules: [rule("title", "contains", "BLUE")] })).toEqual(["Blue in Green"]);
  expect(await pick({ rules: [rule("artist", "is", "miles davis")] })).toEqual([
    "Blue in Green",
    "So What",
    "Spanish Key",
  ]);
  expect(await pick({ rules: [rule("album", "startsWith", "dru")] })).toEqual(["Avril 14th", "Vordhosbn"]);
  expect(await pick({ rules: [rule("genre", "contains", "jazz"), rule("artist", "isNot", "Area")] })).toEqual(
    ["Blue in Green", "So What", "Spanish Key"],
  );
  expect(await pick({ rules: [rule("genre", "notContains", "jazz")] })).toEqual(["Avril 14th", "Vordhosbn"]);
  // Any instead of all.
  expect(
    await pick({ match: "any", rules: [rule("title", "is", "So What"), rule("title", "is", "Return")] }),
  ).toEqual(["Return", "So What"]);
  // A rule without a value yet is left out.
  expect((await create({ rules: [rule("artist", "is", "")] })).matching).toBe(7);
});

test("number rules: year, duration (seconds or m:ss), sample rate (kHz)", async () => {
  expect(await pick({ rules: [rule("year", "between", "1975", "1960")] })).toEqual(["Spanish Key"]);
  expect(await pick({ rules: [rule("year", "lessThan", "1960")] })).toEqual(["Blue in Green", "So What"]);
  expect(
    await pick({ rules: [rule("duration", "greaterThan", "0:02"), rule("duration", "lessThan", "30")] }),
  ).toEqual(["Blue in Green"]);
  expect(await pick({ rules: [rule("sampleRate", "greaterThan", "16")] })).toEqual(["Spanish Key"]);
  expect(await pick({ rules: [rule("lossless", "is", "yes")] })).toHaveLength(7);
});

test("history rules: plays and last played are the user's own; added is when the album appeared", async () => {
  const area = (await pick({ rules: [rule("artist", "is", "Area")] })).length;
  expect(area).toBe(2);
  const tracks = (await create({ rules: [rule("artist", "is", "Area")], order: "title" })).entries;
  const listen = (trackId: string, minutesAgo: number) =>
    inject({
      method: "POST",
      url: "/api/history",
      payload: {
        trackId,
        startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        playedMs: 40_000,
      },
    });
  await listen(tracks[0]!.track!.id, 10);
  await listen(tracks[0]!.track!.id, 5);
  expect(await pick({ rules: [rule("plays", "greaterThan", "1")] })).toEqual(["Il bandito del deserto"]);
  expect(await pick({ rules: [rule("lastPlayed", "inLast", "1")] })).toEqual(["Il bandito del deserto"]);
  expect(await pick({ rules: [rule("lastPlayed", "never"), rule("artist", "is", "Area")] })).toEqual([
    "Return",
  ]);
  const mostPlayed = await create({
    rules: [rule("artist", "is", "Area")],
    order: "plays",
    descending: true,
  });
  expect(titles(mostPlayed)[0]).toBe("Il bandito del deserto");
  expect(await pick({ rules: [rule("added", "inLast", "1")] })).toHaveLength(7);
  expect(await pick({ rules: [rule("added", "notInLast", "1")] })).toEqual([]);
});

test("rules that don't make sense are refused", async () => {
  const refuse = async (rules: Rules) => {
    const res = await inject({ method: "POST", url: "/api/playlists", payload: { name: "Bad", rules } });
    expect(res.statusCode, JSON.stringify(rules)).toBe(400);
  };
  await refuse({ rules: [rule("year", "contains", "19")] });
  await refuse({ rules: [rule("year", "is", "nineteen")] });
  await refuse({ rules: [rule("lossless", "is", "maybe")] });
  await refuse({ limit: 501 });
  await refuse({ rules: [rule("title", "inLast", "3")] });
});

test("a smart playlist isn't edited by hand, but its rules can change", async () => {
  const p = await create({ rules: [rule("genre", "is", "Electronic")] });
  const add = await inject({
    method: "POST",
    url: `/api/playlists/${p.id}/entries`,
    payload: { source: { kind: "genre", name: "Jazz" } },
  });
  expect(add.statusCode).toBe(409);
  const changed = await inject({
    method: "PATCH",
    url: `/api/playlists/${p.id}`,
    payload: { rules: { rules: [rule("genre", "is", "Jazz Fusion")] } },
  });
  expect(titles(Playlist.parse(changed.json()))).toEqual(["Spanish Key"]);
  // An ordinary playlist has no rules to change.
  const plain = Playlist.parse(
    (await inject({ method: "POST", url: "/api/playlists", payload: { name: "P" } })).json(),
  );
  const res = await inject({ method: "PATCH", url: `/api/playlists/${plain.id}`, payload: { rules: {} } });
  expect(res.statusCode).toBe(409);
});

test("a smart playlist follows the library, and plays or shuffles what matches", async () => {
  const p = await create({ rules: [rule("genre", "is", "Electronic")], order: "title" });
  album("Boards of Canada", "Geogaddi", 2002, "Electronic", [{ title: "Music Is Math" }]);
  await ctx.startScan();
  const now = Playlist.parse((await inject(`/api/playlists/${p.id}`)).json());
  expect(titles(now)).toEqual(["Avril 14th", "Music Is Math", "Vordhosbn"]);

  let q = await (async () => {
    const res = await inject({
      method: "PUT",
      url: "/api/queue",
      payload: { source: { kind: "playlist", id: p.id } },
    });
    return QueueState.parse(res.json());
  })();
  expect(q.entries.map((e) => e.track.title)).toEqual(titles(now));

  // Random order: the shuffle keeps the tracks it started with, each once a lap.
  const random = await create({ order: "random", limit: 4 }, "Random four");
  const res = await inject({
    method: "PUT",
    url: "/api/queue",
    payload: { source: { kind: "playlist", id: random.id }, shuffle: true, shuffleScope: "playlist" },
  });
  q = QueueState.parse(res.json());
  expect(q).toMatchObject({ shuffleScope: "playlist", origin: { name: "Random four" } });
  expect(new Set(q.entries.map((e) => e.track.id)).size).toBe(4);
});

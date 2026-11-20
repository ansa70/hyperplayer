import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadioFacets, RadioStation, RadioStationList, RadioStationPage, User } from "@hyperplayer/schemas";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { pngFromIco } from "../src/radio/radio.ts";
import { ADMIN_PASSWORD, authed, setupAdmin, testConfig } from "./helpers.ts";

const JAZZ = "11111111-2222-3333-4444-555555555555";
const ROCK = "66666666-7777-8888-9999-aaaaaaaaaaaa";

const raw = (uuid: string, name: string, extra: Record<string, unknown> = {}) => ({
  stationuuid: uuid,
  name,
  url: "http://example.com/stream.pls",
  url_resolved: `http://stream.example.com/${name.toLowerCase().replaceAll(" ", "-")}`,
  homepage: "https://example.com/",
  favicon: "https://logos.example.com/logo.png",
  tags: "jazz,Smooth Jazz,jazz, ",
  country: "Italy",
  countrycode: "it",
  language: "italian,english",
  codec: "MP3",
  bitrate: 128,
  clickcount: 42,
  ...extra,
});

/** A stand-in for the Radio Browser mirrors and the stations' logo hosts. */
const net = {
  down: new Set<string>(),
  requests: [] as string[],
  stations: [raw(JAZZ, "Jazz Radio"), raw(ROCK, "Rock FM", { favicon: "", codec: "UNKNOWN", bitrate: 0 })],
  logo: Buffer.alloc(0),
  async fetch(url: string): Promise<Response> {
    net.requests.push(url);
    const u = new URL(url);
    if (net.down.has(u.host)) throw new Error("connection refused");
    if (url === "https://all.api.radio-browser.info/json/servers") {
      return Response.json([{ name: "a1.api.radio-browser.info" }, { name: "a2.api.radio-browser.info" }]);
    }
    if (u.host.endsWith(".api.radio-browser.info")) {
      if (u.pathname === "/json/stations/search") {
        const name = u.searchParams.get("name")?.toLowerCase();
        const items = [
          ...net.stations,
          // Unplayable: dropped.
          raw("99999999-9999-9999-9999-999999999999", "Broken", { url: "", url_resolved: "" }),
          { stationuuid: "not-a-uuid", name: "Odd", url: "http://x.example.com/" },
        ].filter((s) => !name || s.name.toLowerCase().includes(name));
        return Response.json(items.slice(0, Number(u.searchParams.get("limit"))));
      }
      if (u.pathname === "/json/stations/byuuid") {
        return Response.json(net.stations.filter((s) => s.stationuuid === u.searchParams.get("uuids")));
      }
      if (u.pathname === "/json/countries") {
        return Response.json([
          { name: "Italy", iso_3166_1: "IT", stationcount: 900 },
          { name: "Germany", iso_3166_1: "DE", stationcount: 3000 },
          { name: "Nowhere", iso_3166_1: "", stationcount: 5 },
        ]);
      }
      if (u.pathname === "/json/tags") {
        return Response.json([
          { name: "rock", stationcount: 50 },
          { name: "Rock", stationcount: 10 },
          { name: "jazz", stationcount: 40 },
          { name: "empty", stationcount: 0 },
        ]);
      }
      return new Response(null, { status: 404 });
    }
    if (u.host === "logos.example.com") {
      return new Response(new Uint8Array(net.logo), { headers: { "content-type": "image/png" } });
    }
    if (u.host === "moved.example.com") {
      return new Response(null, { status: 302, headers: { location: "http://192.168.1.1/logo.png" } });
    }
    return new Response(null, { status: 404 });
  },
};

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let admin: ReturnType<typeof authed>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-radio-"));
  mkdirSync(join(dir, "music"));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), {
    logger: false,
    fetch: (url) => net.fetch(url),
  });
  admin = authed(ctx.app, await setupAdmin(ctx.app));
  net.logo = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  net.down.clear();
  net.requests = [];
});

async function signIn(username: string, password: string) {
  const login = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password, deviceName: "tests" },
  });
  return authed(ctx.app, (login.json() as { token: string }).token);
}

/** Each user's password, once they've chosen it. */
const passwords = new Map<string, string>();

async function user(username: string) {
  const created = User.parse(
    (
      await admin({ method: "POST", url: "/api/users", payload: { username, password: "first password" } })
    ).json(),
  );
  const login = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "first password", deviceName: "tests" },
  });
  const as = authed(ctx.app, (login.json() as { token: string }).token);
  if (created.mustChangePassword) {
    await as({
      method: "POST",
      url: "/api/me/password",
      payload: { currentPassword: "first password", newPassword: `${username} new password` },
    });
  }
  passwords.set(username, created.mustChangePassword ? `${username} new password` : "first password");
  return as;
}

test("search: playable stations only, tidied up, with the filters passed on", async () => {
  const res = await admin("/api/radio/stations?country=it&tag=Jazz&order=trending&limit=10");
  expect(res.statusCode).toBe(200);
  const page = RadioStationPage.parse(res.json());
  expect(page.items.map((s) => s.name)).toEqual(["Jazz Radio", "Rock FM"]);
  expect(page.more).toBe(false);
  expect(page.items[0]).toEqual({
    id: JAZZ,
    name: "Jazz Radio",
    streamUrl: "http://stream.example.com/jazz-radio",
    homepage: "https://example.com/",
    hasLogo: true,
    country: "Italy",
    countryCode: "IT",
    languages: ["italian", "english"],
    tags: ["jazz", "smooth jazz"],
    codec: "MP3",
    bitrate: 128,
    clicks: 42,
    custom: false,
    favourite: false,
  });
  expect(page.items[1]).toMatchObject({ hasLogo: false, codec: null, bitrate: null });
  const search = new URL(net.requests.find((u) => u.includes("/json/stations/search"))!);
  expect(Object.fromEntries(search.searchParams)).toMatchObject({
    countrycode: "IT",
    tag: "jazz",
    tagExact: "true",
    order: "clicktrend",
    reverse: "true",
    hidebroken: "true",
    limit: "10",
  });
});

test("a full page says there may be more; the same search is answered from the cache", async () => {
  const first = RadioStationPage.parse((await admin("/api/radio/stations?limit=2")).json());
  expect(first.more).toBe(true);
  net.requests = [];
  await admin("/api/radio/stations?limit=2");
  expect(net.requests).toEqual([]);
});

test("a mirror that fails is skipped for the next one", async () => {
  net.down.add("a1.api.radio-browser.info");
  net.down.add("a2.api.radio-browser.info");
  const down = await admin("/api/radio/stations?q=nothing-cached");
  expect(down.statusCode).toBe(502);
  expect(down.json()).toMatchObject({ error: "radio_directory_unavailable" });
  net.down.delete("a2.api.radio-browser.info");
  const res = await admin("/api/radio/stations?q=jazz");
  expect(RadioStationPage.parse(res.json()).items.map((s) => s.id)).toEqual([JAZZ]);
});

test("countries and tags: merged, the ones with most stations first", async () => {
  const countries = RadioFacets.parse((await admin("/api/radio/countries")).json()).items;
  expect(countries).toEqual([
    { value: "DE", label: "Germany", stations: 3000 },
    { value: "IT", label: "Italy", stations: 900 },
  ]);
  const tags = RadioFacets.parse((await admin("/api/radio/tags?limit=1")).json()).items;
  expect(tags).toEqual([{ value: "rock", label: "rock", stations: 60 }]);
});

test("favourites: each user's own, kept when the directory is unreachable", async () => {
  const bob = await user("bob");
  const added = await bob({ method: "PUT", url: `/api/radio/favourites/${JAZZ}` });
  expect(RadioStation.parse(added.json())).toMatchObject({ id: JAZZ, favourite: true });
  // Twice is the same.
  await bob({ method: "PUT", url: `/api/radio/favourites/${JAZZ}` });
  expect(RadioStationList.parse((await bob("/api/radio/favourites")).json()).items.map((s) => s.id)).toEqual([
    JAZZ,
  ]);
  expect(RadioStationList.parse((await admin("/api/radio/favourites")).json()).items).toEqual([]);

  const search = RadioStationPage.parse((await bob("/api/radio/stations?q=jazz")).json());
  expect(search.items[0]!.favourite).toBe(true);

  net.down.add("a1.api.radio-browser.info");
  net.down.add("a2.api.radio-browser.info");
  // Not in the server's memory: it would ask the directory.
  await ctx.app.close();
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), {
    logger: false,
    fetch: (url) => net.fetch(url),
  });
  admin = await signIn("admin", ADMIN_PASSWORD);
  const bobAgain = await signIn("bob", passwords.get("bob")!);
  const saved = await bobAgain(`/api/radio/stations/${JAZZ}`);
  expect(saved.statusCode).toBe(200);
  expect(RadioStation.parse(saved.json())).toMatchObject({ name: "Jazz Radio", favourite: true });
  expect((await bobAgain(`/api/radio/stations/${ROCK}`)).statusCode).toBe(502);

  expect((await bobAgain({ method: "DELETE", url: `/api/radio/favourites/${JAZZ}` })).statusCode).toBe(200);
  expect((await bobAgain({ method: "DELETE", url: `/api/radio/favourites/${JAZZ}` })).statusCode).toBe(404);
});

test("a station added by its address is its owner's only", async () => {
  const carol = await user("carol");
  const res = await carol({
    method: "POST",
    url: "/api/radio/stations",
    payload: { name: " My Stream ", streamUrl: "https://radio.example.org:8000/live" },
  });
  expect(res.statusCode).toBe(200);
  const station = RadioStation.parse(res.json());
  expect(station).toMatchObject({
    name: "My Stream",
    streamUrl: "https://radio.example.org:8000/live",
    homepage: null,
    custom: true,
    favourite: true,
    hasLogo: false,
  });
  expect(station.id).toMatch(/^custom-[0-9a-f]{16}$/);
  expect((await carol(`/api/radio/stations/${station.id}`)).statusCode).toBe(200);
  expect((await admin(`/api/radio/stations/${station.id}`)).statusCode).toBe(404);

  const bad = await carol({
    method: "POST",
    url: "/api/radio/stations",
    payload: { name: "Local file", streamUrl: "file:///etc/passwd" },
  });
  expect(bad.statusCode).toBe(400);

  expect((await carol({ method: "DELETE", url: `/api/radio/favourites/${station.id}` })).statusCode).toBe(
    200,
  );
  expect((await carol(`/api/radio/stations/${station.id}`)).statusCode).toBe(404);
});

test("ids that are neither a directory uuid nor a station added are refused", async () => {
  expect((await admin("/api/radio/stations/..%2F..%2Fjson")).statusCode).toBe(400);
  expect((await admin("/api/radio/stations/custom-xyz")).statusCode).toBe(400);
});

test("logos: fetched once, as WebP of the size asked; none on the server's own network", async () => {
  const res = await admin(`/api/radio/stations/${JAZZ}/logo?size=64`);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("image/webp");
  const meta = await sharp(res.rawPayload).metadata();
  expect([meta.width, meta.height]).toEqual([64, 43]);
  net.requests = [];
  expect((await admin(`/api/radio/stations/${JAZZ}/logo?size=32`)).statusCode).toBe(200);
  expect(net.requests.filter((u) => u.includes("logos.example.com"))).toEqual([]);

  expect((await admin(`/api/radio/stations/${ROCK}/logo`)).statusCode).toBe(404);

  const local = "abcdefab-1111-2222-3333-444444444444";
  const moved = "abcdefab-5555-6666-7777-888888888888";
  net.stations.push(
    raw(local, "Local", { favicon: "http://127.0.0.1/logo.png" }),
    raw(moved, "Moved", { favicon: "http://moved.example.com/logo.png" }),
  );
  net.requests = [];
  expect((await admin(`/api/radio/stations/${local}/logo`)).statusCode).toBe(404);
  expect((await admin(`/api/radio/stations/${moved}/logo`)).statusCode).toBe(404);
  expect(net.requests.some((u) => u.includes("127.0.0.1") || u.includes("192.168."))).toBe(false);
});

test("the PNG inside an .ico file is found", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const ico = Buffer.alloc(6 + 16 * 2);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(2, 4);
  // A 16x16 BMP entry, then a 64x64 PNG one.
  ico.writeUInt8(16, 6);
  ico.writeUInt8(16, 7);
  ico.writeUInt32LE(4, 6 + 8);
  ico.writeUInt32LE(0, 6 + 12);
  ico.writeUInt8(64, 22);
  ico.writeUInt8(64, 23);
  ico.writeUInt32LE(png.length, 22 + 8);
  ico.writeUInt32LE(ico.length, 22 + 12);
  expect(Buffer.from(pngFromIco(Buffer.concat([ico, png]))!)).toEqual(png);
  expect(pngFromIco(png)).toBeNull();
});

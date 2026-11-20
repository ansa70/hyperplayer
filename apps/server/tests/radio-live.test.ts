import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadioNowPlaying, RadioStation } from "@hyperplayer/schemas";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { icyTitle, playlistEntry, stripIcy } from "../src/radio/live.ts";
import { setupAdmin, testConfig } from "./helpers.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const STATION = "11111111-2222-3333-4444-555555555555";
const LOCAL = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const HTML = "abcdefab-1111-2222-3333-444444444444";
const PLS = "abcdefab-5555-6666-7777-888888888888";

const METAINT = 1000;
/** Audio bytes are 0xAA here, so any metadata left in the audio shows. */
const AUDIO = 0xaa;

/** An endless ICY stream: METAINT audio bytes, then a metadata block, again and again. */
function icyStream(signal: AbortSignal | null | undefined, title: string, endAfter = Infinity) {
  let blocks = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted || blocks >= endAfter) return controller.close();
      await new Promise((r) => setTimeout(r, 2));
      // A block split over two chunks, to cross chunk boundaries.
      const meta = Buffer.from(`StreamTitle='${title}';StreamUrl='';`);
      const padded = Buffer.alloc(Math.ceil(meta.length / 16) * 16);
      meta.copy(padded);
      const block = Buffer.concat([Buffer.alloc(METAINT, AUDIO), Buffer.from([padded.length / 16]), padded]);
      controller.enqueue(block.subarray(0, 700));
      controller.enqueue(block.subarray(700));
      blocks++;
    },
  });
}

const station = (uuid: string, url: string) => ({
  stationuuid: uuid,
  name: `Station ${uuid.slice(0, 4)}`,
  url,
  url_resolved: url,
  codec: "MP3",
  bitrate: 128,
});

const net = {
  requests: [] as string[],
  /** Connections to the flaky station so far. */
  flaky: 0,
  mp3: Buffer.alloc(0),
  async fetch(url: string, init: RequestInit): Promise<Response> {
    net.requests.push(url);
    const u = new URL(url);
    if (url === "https://all.api.radio-browser.info/json/servers") {
      return Response.json([{ name: "a1.api.radio-browser.info" }]);
    }
    if (u.pathname === "/json/stations/byuuid") {
      const all = [
        station(STATION, "http://icy.example.com/live"),
        station(LOCAL, "http://192.168.1.20:8000/live"),
        station(HTML, "https://html.example.com/"),
        station(PLS, "http://pls.example.com/listen.pls"),
      ];
      return Response.json(all.filter((s) => s.stationuuid === u.searchParams.get("uuids")));
    }
    if (u.pathname.startsWith("/json/url/")) return Response.json({ ok: true });
    const icy = (title: string, endAfter?: number) =>
      new Response(icyStream(init.signal, title, endAfter), {
        headers: { "content-type": "audio/mpeg", "icy-metaint": String(METAINT) },
      });
    switch (u.host) {
      case "icy.example.com":
        return icy("Band - Song");
      case "192.168.1.20:8000":
        return icy("Local - Tune");
      case "html.example.com":
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      case "pls.example.com":
        return new Response("[playlist]\nNumberOfEntries=1\nFile1=http://icy.example.com/live\n", {
          headers: { "content-type": "audio/x-scpls" },
        });
      case "flaky.example.com":
        // The first connection drops after a little; the next one stays.
        return icy(`Take ${++net.flaky}`, net.flaky === 1 ? 3 : Infinity);
      case "ogg.example.com":
        return new Response(new Uint8Array(net.mp3), { headers: { "content-type": "audio/mpeg" } });
    }
    return new Response(null, { status: 404 });
  },
};

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let token: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-radio-live-"));
  mkdirSync(join(dir, "music"));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), {
    logger: false,
    fetch: (url, init) => net.fetch(url, init),
  });
  token = await setupAdmin(ctx.app);
  base = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  if (hasFfmpeg) {
    const out = join(dir, "tone.mp3");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=3", "-b:a", "128k", out]);
    net.mp3 = readFileSync(out);
  }
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  net.requests = [];
});

const api = (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  Object.assign(headers, init.headers);
  return fetch(base + path, { ...init, headers });
};

/** Reads `bytes` of a stream, then hangs up. */
async function listen(res: Response, bytes: number): Promise<Buffer> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < bytes) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    total += r.value.length;
  }
  await reader.cancel();
  return Buffer.concat(chunks);
}

const nowPlaying = async (id: string) =>
  RadioNowPlaying.parse(await (await api(`/api/radio/stations/${id}/now-playing`)).json());

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
};

test("ICY metadata: titles read, in UTF-8 or Latin-1", () => {
  expect(icyTitle(Buffer.from("StreamTitle='Bjørk - Jóga';StreamUrl='';\0\0"))).toBe("Bjørk - Jóga");
  expect(icyTitle(Buffer.from("StreamTitle='Café - Ça va';", "latin1"))).toBe("Café - Ça va");
  expect(icyTitle(Buffer.from("StreamTitle='Guns N' Roses - It's So Easy';StreamUrl='x';"))).toBe(
    "Guns N' Roses - It's So Easy",
  );
  expect(icyTitle(Buffer.from("StreamTitle='';"))).toBeNull();
});

test("ICY metadata is taken out of the audio, wherever the chunks split", async () => {
  const titles: (string | null)[] = [];
  const meta = Buffer.alloc(32);
  meta.write("StreamTitle='A - B';");
  const stream = Buffer.concat([
    Buffer.alloc(10, AUDIO),
    Buffer.from([2]),
    meta,
    Buffer.alloc(10, AUDIO),
    Buffer.from([0]),
    Buffer.alloc(4, AUDIO),
  ]);
  for (const size of [1, 3, 7, stream.length]) {
    titles.length = 0;
    const chunks = (async function* () {
      for (let i = 0; i < stream.length; i += size) yield stream.subarray(i, i + size);
    })();
    const out: Uint8Array[] = [];
    for await (const c of stripIcy(chunks, 10, (t) => titles.push(t))) out.push(c);
    expect(Buffer.concat(out)).toEqual(Buffer.alloc(24, AUDIO));
    expect(titles).toEqual(["A - B"]);
  }
});

test("playlists: the first stream they list", () => {
  const base = new URL("http://example.com/radio/listen.pls");
  expect(
    playlistEntry("[playlist]\nNumberOfEntries=2\nFile1=http://a.example.com/s\nFile2=http://b/", base),
  ).toBe("http://a.example.com/s");
  expect(playlistEntry("#EXTM3U\n#EXTINF:-1,Radio\r\nstream.mp3\r\n", base)).toBe(
    "http://example.com/radio/stream.mp3",
  );
  expect(playlistEntry("#EXTM3U\nfile:///etc/passwd\n", base)).toBeNull();
});

test("an MP3 station plays as it comes, with what it's playing known while listened to", async () => {
  const res = await api(`/api/radio/stations/${STATION}/stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/mpeg");
  const reader = res.body!.getReader();
  let audio = Buffer.alloc(0);
  while (audio.length < 5 * METAINT) audio = Buffer.concat([audio, (await reader.read()).value!]);
  expect(audio.every((b) => b === AUDIO)).toBe(true);
  expect(await nowPlaying(STATION)).toEqual({ title: "Band - Song", artist: "Band", song: "Song" });
  await reader.cancel();
  // Nobody listening: nothing known.
  await until(async () => (await nowPlaying(STATION)).title === null);
  expect((await nowPlaying(STATION)).title).toBeNull();
  // The play was reported to the directory, once an hour per user.
  expect(net.requests.filter((u) => u.endsWith(`/json/url/${STATION}`))).toHaveLength(1);
  await listen(await api(`/api/radio/stations/${STATION}/stream`), 100);
  expect(net.requests.filter((u) => u.endsWith(`/json/url/${STATION}`))).toHaveLength(1);
});

test("a .pls address is followed to its stream", async () => {
  const res = await api(`/api/radio/stations/${PLS}/stream`);
  expect(res.status).toBe(200);
  const audio = await listen(res, 2000);
  expect(audio.subarray(0, 2000).every((b) => b === AUDIO)).toBe(true);
});

test("the directory's stations can't reach into the server's network, a user's own can", async () => {
  const refused = await api(`/api/radio/stations/${LOCAL}/stream`);
  expect(refused.status).toBe(502);
  expect(await refused.json()).toMatchObject({ error: "station_unavailable" });
  expect(net.requests.some((u) => u.includes("192.168."))).toBe(false);

  const own = RadioStation.parse(
    await (
      await api("/api/radio/stations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Home Icecast", streamUrl: "http://192.168.1.20:8000/live" }),
      })
    ).json(),
  );
  const res = await api(`/api/radio/stations/${own.id}/stream`);
  expect(res.status).toBe(200);
  await listen(res, 1000);
});

test("an address that isn't audio is an error", async () => {
  const res = await api(`/api/radio/stations/${HTML}/stream`);
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ error: "station_unavailable" });
});

test("a dropped connection is reconnected and the audio goes on", async () => {
  const own = RadioStation.parse(
    await (
      await api("/api/radio/stations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Flaky", streamUrl: "http://flaky.example.com/live" }),
      })
    ).json(),
  );
  net.flaky = 0;
  const res = await api(`/api/radio/stations/${own.id}/stream`);
  const reader = res.body!.getReader();
  let audio = 0;
  // Past the first connection's 3 blocks.
  while (audio < 6 * METAINT) audio += (await reader.read()).value!.length;
  expect(net.flaky).toBe(2);
  expect((await nowPlaying(own.id)).title).toBe("Take 2");
  await reader.cancel();
});

test.skipIf(!hasFfmpeg)("a station the player can't play as it is gets transcoded", async () => {
  const own = RadioStation.parse(
    await (
      await api("/api/radio/stations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Tone", streamUrl: "http://ogg.example.com/live" }),
      })
    ).json(),
  );
  const res = await api(`/api/radio/stations/${own.id}/stream?direct=&format=opus&bitrate=64`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/ogg");
  const audio = await listen(res, 4);
  expect(audio.subarray(0, 4).toString("latin1")).toBe("OggS");
});

test("someone else's station isn't theirs to listen to", async () => {
  const own = RadioStation.parse(
    await (
      await api("/api/radio/stations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Mine", streamUrl: "http://icy.example.com/live" }),
      })
    ).json(),
  );
  await api("/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "dave", password: "dave's password" }),
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "dave", password: "dave's password", deviceName: "tests" }),
  });
  const dave = ((await login.json()) as { token: string }).token;
  const as = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${dave}` } });
  expect((await as(`/api/radio/stations/${own.id}/stream`)).status).toBe(404);
  expect((await as(`/api/radio/stations/${own.id}/now-playing`)).status).toBe(404);
});

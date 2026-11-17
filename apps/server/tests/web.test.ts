import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { testConfig } from "./helpers.ts";

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-web-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>HyperPlayer</title>");
  writeFileSync(join(web, "assets", "app-1234.js"), "console.log(1)");
  writeFileSync(join(web, "favicon.svg"), "<svg/>");
  writeFileSync(join(dir, "secret.txt"), "not for the web");
  mkdirSync(join(dir, "music"));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data"), { webDir: web }), { logger: false });
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the web player is served at /, with its own links routed to it", async () => {
  for (const url of ["/", "/album/abc", "/queue?x=1"]) {
    const r = await ctx.app.inject(url);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.body).toContain("<title>HyperPlayer</title>");
  }
});

test("its assets are cached, and nothing outside it is served", async () => {
  const js = await ctx.app.inject("/assets/app-1234.js");
  expect(js.headers["content-type"]).toContain("text/javascript");
  expect(js.headers["cache-control"]).toContain("immutable");
  expect(js.body).toBe("console.log(1)");
  expect((await ctx.app.inject("/favicon.svg")).headers["content-type"]).toBe("image/svg+xml");
  for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
    const r = await ctx.app.inject(url);
    expect(r.body).not.toContain("not for the web");
  }
  expect((await ctx.app.inject("/%E0%A4%A")).statusCode).toBe(400);
});

test("the API keeps its own 404s", async () => {
  const r = await ctx.app.inject("/api/nope");
  expect(r.statusCode).toBe(404);
  expect(r.json()).toMatchObject({ error: "not_found" });
  expect((await ctx.app.inject({ method: "POST", url: "/album/x" })).statusCode).toBe(404);
});

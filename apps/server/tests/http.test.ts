import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { setupAdmin, testConfig } from "./helpers.ts";

let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
let token: string;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hyperplayer-http-"));
  ctx = await buildApp(testConfig(join(dir, "music"), join(dir, "data")), { logger: false });
  token = await setupAdmin(ctx.app);
  await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  port = (ctx.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A POST over a real connection, `body` written as given (chunked unless a length is set). */
function post(
  path: string,
  headers: Record<string, string>,
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("a bodyless request still works when it arrives with an empty body", async () => {
  // As a proxy forwards an HTTP/2 POST without a body: an empty chunked body, no type.
  expect((await post("/api/library/scan", { "transfer-encoding": "chunked" })).status).toBe(200);
  // As some clients send it: an empty body typed as JSON.
  expect(
    (await post("/api/library/scan", { "content-type": "application/json", "content-length": "0" })).status,
  ).toBe(200);
});

test("malformed bodies are the client's error, not a server error", async () => {
  const broken = await post("/api/queue/next", { "content-type": "application/json" }, "{not json");
  expect(broken.status).toBe(400);
  expect(JSON.parse(broken.body)).toMatchObject({ error: "bad_request" });
  const typed = await post("/api/queue/next", { "content-type": "text/csv" }, "a,b");
  expect(typed.status).toBe(415);
});

import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, expect, test } from "vite-plus/test";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { loadTls, selfSigned } from "../src/http/tls.ts";
import { testConfig } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "hyperplayer-tls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("HTTPS is on unless the server only listens on this machine", () => {
  expect(loadConfig({ HP_HOST: "127.0.0.1" }).tls).toBeNull();
  expect(loadConfig({ HP_HOST: "0.0.0.0" }).tls).toEqual({ certFile: null, keyFile: null, names: [] });
  expect(loadConfig({ HP_HOST: "0.0.0.0", HP_TLS: "off" }).tls).toBeNull();
  expect(loadConfig({ HP_HOST: "127.0.0.1", HP_TLS: "on", HP_TLS_NAMES: "nas, 10.0.0.5" }).tls).toMatchObject(
    {
      names: ["nas", "10.0.0.5"],
    },
  );
  expect(() => loadConfig({ HP_TLS_CERT: "/x.pem" })).toThrow(/HP_TLS_KEY/);
});

test("a self-signed certificate is valid, signed by its own key, and names the server", () => {
  const { cert } = selfSigned(["localhost", "music.home", "192.168.1.20", "fd00::1"]);
  const x509 = new X509Certificate(cert);
  expect(x509.verify(x509.publicKey)).toBe(true);
  expect(x509.checkHost("music.home")).toBe("music.home");
  expect(x509.checkIP("192.168.1.20")).toBe("192.168.1.20");
  expect(x509.checkIP("fd00::1")).toBeDefined();
  expect(x509.checkHost("elsewhere")).toBeUndefined();
  expect(x509.ca).toBe(false);
  expect(Date.parse(x509.validTo) - Date.now()).toBeGreaterThan(9 * 365 * 86_400_000);
});

test("the certificate is kept across restarts, and remade for a new name", () => {
  const data = join(dir, "keep");
  const first = loadTls({ certFile: null, keyFile: null, names: [] }, data);
  expect(first.selfSigned).toBe(true);
  expect(loadTls({ certFile: null, keyFile: null, names: [] }, data).fingerprint).toBe(first.fingerprint);
  const named = loadTls({ certFile: null, keyFile: null, names: ["music.home"] }, data);
  expect(named.fingerprint).not.toBe(first.fingerprint);
  expect(new X509Certificate(named.cert).checkHost("music.home")).toBe("music.home");
});

test("the server speaks HTTPS with it", async () => {
  const data = join(dir, "serve");
  const ctx = await buildApp(
    testConfig(join(dir, "music"), data, { tls: { certFile: null, keyFile: null, names: [] } }),
    { logger: false },
  );
  try {
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = ctx.app.server.address() as AddressInfo;
    const { status, fingerprint } = await new Promise<{ status: number; fingerprint: string }>(
      (resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/api/auth/status", rejectUnauthorized: false },
          (res) => {
            const cert = (res.socket as TLSSocket).getPeerCertificate();
            res.resume();
            resolve({ status: res.statusCode!, fingerprint: cert.fingerprint256 });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(status).toBe(200);
    expect(fingerprint).toBe(ctx.tls!.fingerprint);
  } finally {
    await ctx.app.close();
  }
});

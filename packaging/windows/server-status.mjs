// Run by the Windows installer with the bundled node.exe once the service is started:
// waits for the server to answer, then prints where players connect and, for a
// self-signed certificate, its fingerprint. Exits 1 if it doesn't answer in a minute.
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { hostname } from "node:os";
import { join } from "node:path";

const home = join(process.env.ProgramData ?? "C:\\ProgramData", "HyperPlayer");

// The installer writes server.env as UTF-16; edited by hand it may be UTF-8.
function readSettings(file) {
  const bytes = readFileSync(file);
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le").slice(1) : bytes.toString("utf8");
  const settings = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*'?(.*?)'?\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) settings[m[1]] = m[2];
  }
  return settings;
}

const settings = readSettings(join(home, "server.env"));
const port = Number(settings.HP_PORT ?? 4533);
const tls = settings.HP_TLS !== "off";
const answers = () =>
  new Promise((resolve) => {
    const req = (tls ? https : http)(
      { host: "127.0.0.1", port, path: "/api/auth/status", rejectUnauthorized: false, timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });

const deadline = Date.now() + 60_000;
while (!(await answers())) {
  if (Date.now() > deadline) process.exit(1);
  await new Promise((r) => setTimeout(r, 1000));
}
const host = (settings.HP_TLS_NAMES ?? "").split(",")[0]?.trim() || hostname();
console.log(`${tls ? "https" : "http"}://${host}:${port}`);
const cert = join(home, "data", "tls", "cert.pem");
if (tls && !settings.HP_TLS_CERT && existsSync(cert)) {
  console.log(new X509Certificate(readFileSync(cert)).fingerprint256);
}

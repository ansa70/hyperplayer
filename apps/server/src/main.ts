import type { AddressInfo } from "node:net";
import { buildApp, SERVER_VERSION } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app, startScan, tls, folders, embeddedSession } = await buildApp(config);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void app.close().then(() => process.exit(0));
};

await app.listen({ host: config.host, port: config.port });
if (embeddedSession) {
  // For the player that started us: where to connect and as whom. Only it reads our
  // stdout pipe; the token is never logged.
  const { port } = app.server.address() as AddressInfo;
  process.stdout.write(
    `HYPERPLAYER-READY ${JSON.stringify({ port, token: embeddedSession.token, version: SERVER_VERSION })}\n`,
  );
  // The player holds our stdin open: it closes when the player quits, or crashes.
  process.stdin.on("end", shutdown);
  process.stdin.on("error", shutdown);
  process.stdin.resume();
  app.log.info(`Library engine on 127.0.0.1:${port}`);
} else if (tls) {
  app.log.info(
    tls.selfSigned
      ? `HTTPS with a self-signed certificate. Clients ask to trust it the first time: check that they show SHA-256 ${tls.fingerprint}`
      : `HTTPS (certificate SHA-256 ${tls.fingerprint})`,
  );
} else {
  app.log.info("Plain HTTP (HP_TLS)");
}
app.log.info(`Library: ${folders.paths.join(", ")}`);
void startScan();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, shutdown);
}

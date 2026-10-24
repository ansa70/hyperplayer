import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app, startScan, tls } = await buildApp(config);

await app.listen({ host: config.host, port: config.port });
if (tls) {
  app.log.info(
    tls.selfSigned
      ? `HTTPS with a self-signed certificate. Clients ask to trust it the first time: check that they show SHA-256 ${tls.fingerprint}`
      : `HTTPS (certificate SHA-256 ${tls.fingerprint})`,
  );
} else {
  app.log.info("Plain HTTP (HP_TLS)");
}
app.log.info(`Library: ${config.libraryPaths.join(", ")}`);
void startScan();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}

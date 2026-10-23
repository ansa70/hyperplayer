import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app, startScan } = await buildApp(config);

await app.listen({ host: config.host, port: config.port });
app.log.info(`Library: ${config.libraryPath}`);
void startScan();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}

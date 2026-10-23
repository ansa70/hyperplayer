// Writes the language-neutral API description consumed by non-TS clients.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { jsonSchemaBundle, openApiDocument } from "../src/index.ts";

const outDir = resolve(import.meta.dirname, "../../../api");
mkdirSync(outDir, { recursive: true });
const write = (name: string, doc: unknown) =>
  writeFileSync(resolve(outDir, name), `${JSON.stringify(doc, null, 2)}\n`);

write("schema.json", jsonSchemaBundle());
write("openapi.json", openApiDocument());
console.log(`Wrote schema.json and openapi.json to ${outDir}`);

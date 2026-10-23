import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Db } from "../db.ts";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const hex = (n: number) => n.toString(16).padStart(2, "0");

/**
 * Content-addressed artwork store: identical images embedded in many tracks
 * are written and analysed once.
 */
export class ArtworkStore {
  readonly dir: string;
  readonly #db: Db;
  readonly #known = new Set<string>();

  constructor(db: Db, dataDir: string) {
    this.#db = db;
    this.dir = join(dataDir, "artwork");
  }

  async put(data: Uint8Array, mime: string): Promise<string | null> {
    const id = createHash("sha1").update(data).digest("hex").slice(0, 20);
    if (this.#known.has(id) || this.#db.prepare("SELECT 1 FROM artwork WHERE id = ?").get(id)) {
      this.#known.add(id);
      return id;
    }
    try {
      const image = sharp(data);
      const [meta, stats] = await Promise.all([image.metadata(), image.stats()]);
      const format = meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}`;
      const path = join(this.dir, `${id}.${EXT[format] ?? EXT[mime] ?? "bin"}`);
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, data);
      const { r, g, b } = stats.dominant;
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO artwork (id, path, mime, width, height, dominant_color) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, path, format, meta.width ?? null, meta.height ?? null, `#${hex(r)}${hex(g)}${hex(b)}`);
      this.#known.add(id);
      return id;
    } catch {
      // Corrupt or unsupported embedded image: treat the track as having no cover.
      return null;
    }
  }
}

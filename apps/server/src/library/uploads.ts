import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UploadInfo } from "@hyperplayer/schemas";
import { parseFile } from "music-metadata";
import type { Db } from "../db.ts";
import { HttpError } from "../http/contract.ts";
import { tracksChanged } from "./dedupe.ts";
import { AUDIO_EXTENSIONS, type Scanner } from "./scanner.ts";
import { deleteOrphans } from "./tracks.ts";

type Row = Record<string, unknown>;

export interface UploadConfig {
  dir: string;
  maxFileBytes: number;
  quotaBytes: number | null;
}

/** Characters that can't be in a file or folder name on Windows or Linux, or would hide it. */
function safeName(name: string, fallback: string): string {
  const cleaned = name
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Users' uploads: each user's files under `<dir>/<user id>/<Artist>/<Album>/`, seen only
 * by them (see `viewer`). A file arrives in a hidden folder (scans skip it), is checked
 * against the limits as it streams in, then filed by its tags and added to the library.
 */
export class Uploads {
  readonly #db: Db;
  readonly #scanner: Scanner;
  readonly #config: UploadConfig | null;

  constructor(db: Db, scanner: Scanner, config: UploadConfig | null) {
    this.#db = db;
    this.#scanner = scanner;
    this.#config = config;
  }

  /** The uploads folder, to scan with the music folders; null when uploads are off. */
  get dir(): string | null {
    return this.#config?.dir ?? null;
  }

  #used(userId: string): { bytes: number; tracks: number } {
    const r = this.#db
      .prepare(
        "SELECT COALESCE(SUM(file_size), 0) AS bytes, COUNT(*) AS n FROM all_tracks WHERE owner_id = ?",
      )
      .get(userId) as Row;
    return { bytes: Number(r.bytes), tracks: Number(r.n) };
  }

  info(userId: string): UploadInfo {
    const used = this.#used(userId);
    return {
      enabled: this.#config !== null,
      maxFileBytes: this.#config?.maxFileBytes ?? 0,
      quotaBytes: this.#config?.quotaBytes ?? null,
      usedBytes: used.bytes,
      tracks: used.tracks,
    };
  }

  /**
   * Receives `body` (a file named `name`) for `userId`; returns the track's id: the new
   * one, or the one already in the library that it's a copy of (shown instead of it).
   */
  async receive(userId: string, name: string, body: Readable, declaredBytes: number | null): Promise<string> {
    const config = this.#config;
    if (!config) throw new HttpError(404, "uploads_off", "This server doesn't take uploads");
    const ext = extname(name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) {
      throw new HttpError(415, "not_audio", `Not an audio file the library reads (${ext || "no extension"})`);
    }
    const room = config.quotaBytes === null ? Infinity : config.quotaBytes - this.#used(userId).bytes;
    const limit = Math.min(config.maxFileBytes, room);
    const tooBig = () =>
      limit === room
        ? new HttpError(413, "quota_exceeded", "Not enough room left in your uploads")
        : new HttpError(413, "too_large", `Files up to ${Math.round(config.maxFileBytes / 1048576)} MB`);
    if (declaredBytes !== null && declaredBytes > limit) throw tooBig();

    const home = join(config.dir, userId);
    const incoming = join(home, ".incoming");
    await mkdir(incoming, { recursive: true });
    const temp = join(incoming, `${randomBytes(8).toString("hex")}${ext}`);
    let received = 0;
    let over = false;
    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit && !over) {
        over = true;
        body.destroy(tooBig());
      }
    });
    try {
      await pipeline(body, createWriteStream(temp));
    } catch (err) {
      await unlink(temp).catch(() => {});
      if (over) throw tooBig();
      throw err;
    }

    try {
      const { common } = await parseFile(temp, { duration: false, skipCovers: true });
      const artist = safeName(common.albumartist || common.artist || "", "Unknown Artist");
      const album = safeName(common.album || "", "Unknown Album");
      const title = safeName(common.title || name.slice(0, -ext.length), "Track");
      const number = common.track.no ? `${String(common.track.no).padStart(2, "0")} - ` : "";
      const disc = common.disk.no && (common.disk.of ?? 1) > 1 ? `${common.disk.no}-` : "";
      const folder = join(home, artist, album);
      await mkdir(folder, { recursive: true });
      let target = join(folder, `${disc}${number}${title}${ext}`);
      for (
        let n = 2;
        await stat(target).then(
          () => true,
          () => false,
        );
        n++
      ) {
        target = join(folder, `${disc}${number}${title} (${n})${ext}`);
      }
      await rename(temp, target);
      await this.#scanner.indexFile(target);
      // A copy of a track already in the library is shown as that one: return what's seen.
      const r = this.#db
        .prepare("SELECT COALESCE(duplicate_of, id) AS id FROM all_tracks WHERE path = ?")
        .get(target) as Row | undefined;
      if (!r) throw new Error("the uploaded file wasn't added to the library");
      return String(r.id);
    } catch (err) {
      await unlink(temp).catch(() => {});
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, "unreadable", `Can't read this file: ${(err as Error).message}`);
    }
  }

  /** The caller's uploads, newest first: their ids, for the catalog to fetch. */
  list(userId: string, offset: number, limit: number): { ids: string[]; total: number } {
    const ids = (
      this.#db
        .prepare(
          "SELECT id FROM all_tracks WHERE owner_id = ? AND duplicate_of IS NULL ORDER BY mtime_ms DESC, id LIMIT ? OFFSET ?",
        )
        .all(userId, limit, offset) as Row[]
    ).map((r) => String(r.id));
    const total = Number(
      (
        this.#db
          .prepare("SELECT COUNT(*) AS n FROM all_tracks WHERE owner_id = ? AND duplicate_of IS NULL")
          .get(userId) as Row
      ).n,
    );
    return { ids, total };
  }

  /** Deletes an upload (its owner, or an admin): the file, then the track. */
  async delete(trackId: string, userId: string, admin: boolean): Promise<void> {
    const r = this.#db.prepare("SELECT path, owner_id FROM all_tracks WHERE id = ?").get(trackId) as
      | Row
      | undefined;
    const owner = (r?.owner_id as string | null | undefined) ?? null;
    // Someone else's upload is "not found" to a user: they can't see it.
    if (!r || owner === null || (owner !== userId && !admin)) {
      throw new HttpError(404, "not_found", "No such upload");
    }
    const path = String(r.path);
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    this.#db.prepare("DELETE FROM all_tracks WHERE id = ?").run(trackId);
    deleteOrphans(this.#db);
    tracksChanged(this.#db);
    await this.#removeEmptyFolders(dirname(path), join(this.#config!.dir, owner));
  }

  /** Removes a deleted user's uploads (their rows go with the user). */
  async removeUser(userId: string): Promise<void> {
    const dir = this.#config?.dir;
    if (!dir || !userId || userId.includes(sep) || userId.startsWith(".")) return;
    await rm(join(dir, userId), { recursive: true, force: true });
    deleteOrphans(this.#db);
    tracksChanged(this.#db);
  }

  /** Removes `from` and its parents while empty, up to (not including) `top`. */
  async #removeEmptyFolders(from: string, top: string) {
    let dir = from;
    while (relative(top, dir) && !relative(top, dir).startsWith("..")) {
      if ((await readdir(dir).catch(() => ["?"])).length > 0) return;
      await rmdir(dir).catch(() => {});
      dir = dirname(dir);
    }
  }
}

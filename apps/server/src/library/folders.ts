import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Db } from "../db.ts";
import { HttpError } from "../http/contract.ts";

const KEY = "library_folders";

/** What's saved: the folders an admin chose, and the HP_LIBRARY they replaced. */
interface Saved {
  paths: string[];
  environment: string[];
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/**
 * The music folders: HP_LIBRARY's, unless an admin changed them from a client. The most
 * recent change wins: when HP_LIBRARY itself changes later (say, through the installer),
 * it replaces a change made here.
 */
export class LibraryFolders {
  readonly #db: Db;
  readonly #environment: string[];
  #paths: string[];

  constructor(db: Db, environment: string[]) {
    this.#db = db;
    this.#environment = environment;
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value: string } | undefined;
    const saved = row ? (JSON.parse(row.value) as Saved) : null;
    if (saved && same(saved.environment, environment)) {
      this.#paths = saved.paths;
    } else {
      if (saved) db.prepare("DELETE FROM meta WHERE key = ?").run(KEY);
      this.#paths = environment;
    }
  }

  get paths(): string[] {
    return this.#paths;
  }

  /**
   * Replaces the folders. Each must be an existing folder now: a typo would otherwise
   * look like an empty folder, and take its tracks out of the library.
   */
  async set(paths: string[]) {
    const wanted = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
    if (!wanted.length) throw new HttpError(400, "no_folders", "The library needs at least one folder");
    for (const path of wanted) {
      if (!isAbsolute(path)) {
        const start = process.platform === "win32" ? "a drive, like D:\\" : "/";
        throw new HttpError(
          400,
          "relative_folder",
          `${path} isn't a full path (it should start with ${start})`,
        );
      }
      const isFolder = await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isFolder) throw new HttpError(400, "folder_not_found", `There's no folder ${path} on the server`);
    }
    this.#paths = wanted.map((p) => resolve(p));
    const saved: Saved = { paths: this.#paths, environment: this.#environment };
    this.#db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY, JSON.stringify(saved));
  }
}

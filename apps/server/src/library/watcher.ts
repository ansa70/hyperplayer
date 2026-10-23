import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SETTLE_MS } from "./scanner.ts";

export interface WatchLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Every directory under `root` (included), skipping hidden ones. */
async function directories(root: string): Promise<string[]> {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    const entries = await readdir(out[i]!, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) out.push(join(out[i]!, e.name));
  }
  return out;
}

/**
 * Keeps the library current: rescans every `rescanMinutes`, and (with `watch`)
 * shortly after the filesystem reports changes. Polling is what works everywhere:
 * network shares (SMB, NFS) don't report changes made on the server, and some
 * filesystems report nothing at all; watching just makes local changes show up
 * at once. Rescans are cheap, since unchanged files are only stat'ed.
 *
 * Only directories are watched (a directory's watch reports changes to the files
 * in it), so a library needs one watch per folder rather than one per track;
 * Node's recursive mode would add one for every file.
 */
export class LibraryWatcher {
  readonly #watchers = new Map<string, FSWatcher>();
  /** Roots we've already warned about, so a missing share doesn't log every rescan. */
  readonly #warned = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(
    readonly roots: string[],
    readonly opts: {
      rescanMinutes: number;
      watch: boolean;
      debounceMs?: number;
      rescan: () => void;
      log: WatchLog;
    },
  ) {}

  async start() {
    if (this.opts.rescanMinutes > 0) {
      this.#timer = setInterval(this.opts.rescan, this.opts.rescanMinutes * 60_000);
      this.#timer.unref();
    }
    await this.sync();
  }

  /**
   * Watches every directory of every root, adding new ones and dropping vanished
   * ones (a share mounted or unmounted, albums added). Called after each scan.
   */
  async sync() {
    if (!this.opts.watch || this.#closed) return;
    const wanted = new Set<string>();
    for (const root of this.roots) {
      const dirs = await directories(root);
      for (const d of dirs) wanted.add(d);
      if (!this.#watch(root)) continue;
      for (const d of dirs.slice(1)) this.#watch(d);
    }
    for (const [dir, w] of this.#watchers) {
      if (!wanted.has(dir)) {
        w.close();
        this.#watchers.delete(dir);
      }
    }
  }

  /** Whether `dir` is (now) watched. */
  #watch(dir: string): boolean {
    if (this.#watchers.has(dir)) return true;
    if (this.#closed) return false;
    try {
      const w = watch(dir, { persistent: false }, (_event, file) => {
        // Hidden files are temporary downloads, editor swap files and the like.
        if (file?.startsWith(".")) return;
        this.#changed();
      });
      w.on("error", () => {
        // Typically the directory was removed or its share unmounted; sync() re-adds it if it returns.
        w.close();
        this.#watchers.delete(dir);
        this.#changed();
      });
      this.#watchers.set(dir, w);
      this.#warned.delete(dir);
      return true;
    } catch (err) {
      // Missing folder, unsupported filesystem, or out of inotify watches.
      if (this.roots.includes(dir) && !this.#warned.has(dir)) {
        this.#warned.add(dir);
        this.opts.log.warn(`cannot watch ${dir} (${(err as Error).message}); relying on periodic rescans`);
      }
      return false;
    }
  }

  /** How many directories are being watched. */
  get watching(): number {
    return this.#watchers.size;
  }

  /** A burst of changes (an album being copied) becomes one rescan once it settles. */
  #changed() {
    if (this.#closed) return;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.opts.rescan();
    }, this.opts.debounceMs ?? SETTLE_MS);
    this.#debounce.unref();
  }

  /** Files were still being written during a scan: look again once they've settled. */
  scheduleSoon() {
    this.#changed();
  }

  close() {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
  }
}

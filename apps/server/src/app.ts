import { readdir, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import type { Server as TlsServer } from "node:tls";
import type { Readable } from "node:stream";
import { join } from "node:path";
import cors from "@fastify/cors";
import { api, openApiDocument, type ApiError, type LibraryStatus, type Session } from "@hyperplayer/schemas";
import Fastify, { type FastifyReply } from "fastify";
import sharp from "sharp";
import { Catalog } from "./catalog/catalog.ts";
import { Playlists } from "./collections/playlists.ts";
import { Queues } from "./collections/queues.ts";
import { Enricher } from "./enrich/enricher.ts";
import { httpClient } from "./enrich/http.ts";
import { LyricsService } from "./lyrics/lyrics.ts";
import { History } from "./history/history.ts";
import { Scrobbler, type Fetch } from "./history/scrobbler.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { Auth, type AuthContext } from "./auth/auth.ts";
import { HttpError, notFound, Router, SESSION_COOKIE } from "./http/contract.ts";
import { loadTls, stampOf } from "./http/tls.ts";
import { ArtworkStore } from "./library/artwork.ts";
import { Scanner } from "./library/scanner.ts";
import { LibraryFolders } from "./library/folders.ts";
import { LibraryWatcher } from "./library/watcher.ts";
import { Waveforms } from "./library/waveform.ts";
import {
  mimeForContainer,
  openFile,
  parseRange,
  throttle,
  transcode,
  TranscodeError,
} from "./stream/stream.ts";

export const SERVER_VERSION = "0.1.0-beta.1";

export async function buildApp(config: Config, opts: { logger?: boolean; fetch?: Fetch } = {}) {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "library.db"));
  const artwork = new ArtworkStore(db, config.dataDir);
  const scanner = new Scanner(db, artwork, { settleMs: config.scanSettleMs });
  const tls = config.tls ? loadTls(config.tls, config.dataDir) : null;
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: config.trustProxy,
    https: tls ? { key: tls.key, cert: tls.cert } : null,
  });
  if (tls && config.tls?.certFile && config.tls.keyFile) {
    // Renewed certificate files (e.g. by certbot) are picked up without a restart.
    const files = [config.tls.certFile, config.tls.keyFile];
    let stamp = tls.stamp;
    const timer = setInterval(() => {
      try {
        if (stampOf(files) === stamp) return;
        const renewed = loadTls(config.tls!, config.dataDir);
        (app.server as unknown as TlsServer).setSecureContext({ key: renewed.key, cert: renewed.cert });
        stamp = renewed.stamp;
        app.log.info(`TLS certificate reloaded (SHA-256 ${renewed.fingerprint})`);
      } catch (err) {
        app.log.warn({ err }, "reloading the TLS certificate failed");
      }
    }, 3600_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  const enricher = new Enricher(db, artwork, app.log, config.enrich);
  const catalog = new Catalog(db, enricher);
  const playlists = new Playlists(db, catalog);
  const queues = new Queues(db, catalog, (userId) => auth.preferences(userId).shuffleScope);
  const scrobbler = new Scrobbler(db, app.log, {
    version: SERVER_VERSION,
    fetch: opts.fetch,
    lastfm: config.lastfm,
  });
  app.addHook("onClose", async () => scrobbler.close());
  const history = new History(db, catalog, scrobbler);
  const waveforms = new Waveforms(db, config.ffmpeg);
  // LRCLIB is an online lookup like enrichment, so it's off when enrichment is.
  const lyrics = new LyricsService(
    db,
    config.enrich.enabled
      ? httpClient({
          userAgent: `HyperPlayer/${SERVER_VERSION} ( ${config.enrich.contact} )`,
          minIntervalMs: { "lrclib.net": 250 },
        })
      : null,
  );
  // Native clients ignore CORS; browsers get access only from explicitly listed origins.
  if (config.corsOrigins.length) await app.register(cors, { origin: config.corsOrigins, credentials: true });

  const folders = new LibraryFolders(db, config.libraryPaths);
  let scanning: Promise<void> | null = null;
  let again: Promise<void> | null = null;
  /** A cancel also drops the scan queued after the running one. */
  let dropQueued = false;
  const scanOnce = () =>
    scanner
      .scan(folders.paths)
      .then((s) => {
        const changed = s.updated > 0 || s.removed > 0;
        // Periodic rescans that find nothing new stay quiet.
        if (s.cancelled) app.log.info(s, "library scan cancelled");
        else if (changed || s.errors || s.unavailable.length) app.log.info(s, "library scan finished");
        if (s.unsettled) watcher.scheduleSoon();
        if (changed) {
          const relinked = playlists.relink();
          if (relinked) app.log.info({ relinked }, "playlist entries relinked to moved tracks");
          enricher.enqueuePending();
        }
      })
      .catch((err: unknown) => app.log.error(err, "library scan failed"))
      .finally(() => {
        scanning = null;
        void watcher.sync();
      });
  /**
   * Scans the library. While a scan runs, a request starts one more scan after it
   * (the running one may already have passed the changed files); further requests
   * join that one.
   */
  const startScan = (): Promise<void> => {
    if (!scanning) return (scanning = scanOnce());
    again ??= scanning.then(() => {
      again = null;
      if (dropQueued) {
        dropQueued = false;
        return;
      }
      return startScan();
    });
    return again;
  };
  const watcher = new LibraryWatcher(folders.paths, {
    rescanMinutes: config.rescanMinutes,
    watch: config.watch,
    debounceMs: config.watchDebounceMs,
    rescan: () => void startScan(),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  });
  void watcher.start();
  app.addHook("onClose", async () => watcher.close());
  /** Folder paths describe the server's filesystem: only admins see them. */
  const status = async (admin: boolean): Promise<LibraryStatus> => ({
    scanning: scanning !== null,
    folders: admin
      ? await Promise.all(
          folders.paths.map(async (path) => ({
            path,
            available: await readdir(path).then(
              (entries) => entries.length > 0,
              () => false,
            ),
            tracks: catalog.tracksUnder(path),
          })),
        )
      : [],
    lastScanAt: catalog.lastScanAt(),
    pathStyle: process.platform === "win32" ? "windows" : "posix",
    ...catalog.counts(),
    enrichmentQueue: enricher.queueSize,
    scanProgress: scanner.progress,
  });

  // A request without a body can still arrive with an empty one: a proxy turning HTTP/2
  // into HTTP/1.1 sends an empty chunked body without a type, some clients an empty JSON
  // one. Both mean no body.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) =>
    body === "" ? done(null, undefined) : parseJson(req, body as string, done),
  );
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) =>
    body === ""
      ? done(null, undefined)
      : done(new HttpError(415, "unsupported_media_type", "Request bodies are JSON"), undefined),
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: err.code, message: err.message });
    // Fastify's own refusals (a malformed body, say) are the client's error, not ours.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .status(status)
        .send({ error: "bad_request", message: (err as Error).message } satisfies ApiError);
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Internal server error" } satisfies ApiError);
  });

  const auth = new Auth(db, config.defaultAdminPassword);
  if (await auth.ensureDefaultAdmin()) {
    app.log.warn(
      `Created the "admin" account with the default password. Sign in from a client to choose a real one; ` +
        `until then it can do nothing else.`,
    );
  }
  const route = new Router(app, auth, { validateResponses: config.validateResponses });
  const ok = { ok: true as const };
  const who = (a: AuthContext) => ({ deviceId: a.deviceId, userId: a.user.id });

  // ------------------------------------------------------------------ auth
  route.json(api.authStatus, () => ({
    defaultAdmin: auth.defaultAdminActive,
    serverVersion: SERVER_VERSION,
  }));
  const startSession = (session: Session, wantsCookie: boolean, reply: FastifyReply) => {
    if (wantsCookie) {
      reply.header(
        "Set-Cookie",
        `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` +
          (config.secureCookies ? "; Secure" : ""),
      );
    }
    return session;
  };
  route.json(api.login, async ({ body, request, reply }) =>
    startSession(await auth.login(body, request.ip), body.cookie, reply),
  );
  route.json(api.logout, ({ auth: a, reply }) => {
    auth.revoke(a, a.deviceId);
    reply.header("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return ok;
  });
  route.json(api.me, ({ auth: a }) => ({ user: a.user, device: auth.device(a) }));
  route.json(api.changePassword, async ({ auth: a, body }) => {
    await auth.changePassword(a, body.currentPassword, body.newPassword);
    return ok;
  });
  route.json(api.listDevices, ({ auth: a }) => auth.devices(a));
  route.json(api.revokeDevice, ({ auth: a, params }) => (auth.revoke(a, params.id), ok));
  route.json(api.onboard, ({ auth: a, body }) => auth.onboard(a, body));
  route.json(api.getPreferences, ({ auth: a }) => auth.preferences(a.user.id));
  route.json(api.updatePreferences, ({ auth: a, body }) => auth.updatePreferences(a.user.id, body));
  route.json(api.listUsers, () => auth.users());
  route.json(api.createUser, ({ body }) =>
    auth.createUser(body.username, body.password, body.admin, body.fullName),
  );

  // --------------------------------------------------------------- library
  route.json(api.libraryStatus, ({ auth: a }) => status(a.user.admin));
  route.json(api.libraryScan, () => (void startScan(), status(true)));
  route.json(api.cancelLibraryScan, () => {
    if (again) dropQueued = true;
    scanner.cancel();
    return status(true);
  });
  route.json(api.setLibraryFolders, async ({ body }) => {
    await folders.set(body.paths);
    watcher.setRoots(folders.paths);
    void startScan();
    return status(true);
  });
  route.json(api.listArtists, ({ query }) => catalog.listArtists(query.offset, query.limit));
  route.json(
    api.getArtist,
    ({ params }) => catalog.getArtist(params.id) ?? Promise.reject(notFound("Artist")),
  );
  route.json(api.getArtistAlbums, ({ params }) => catalog.artistAlbums(params.id));
  route.json(api.listAlbums, ({ query }) => catalog.listAlbums(query.offset, query.limit, query.sort));
  route.json(api.getAlbum, ({ params }) => catalog.getAlbum(params.id) ?? Promise.reject(notFound("Album")));
  route.json(api.listTracks, ({ query }) => catalog.listTracks(query.offset, query.limit));
  route.json(api.nowPlaying, ({ params }) => {
    enricher.prioritizeTrack(params.id);
    return catalog.nowPlaying(params.id) ?? Promise.reject(notFound("Track"));
  });
  route.json(api.trackCredits, ({ params }) => {
    enricher.prioritizeTrack(params.id);
    return catalog.trackCredits(params.id) ?? Promise.reject(notFound("Track"));
  });
  route.json(api.waveform, ({ params }) => waveforms.get(params.id) ?? Promise.reject(notFound("Track")));
  route.json(api.lyrics, ({ params }) => lyrics.get(params.id) ?? Promise.reject(notFound("Track")));
  route.json(api.enrichArtist, ({ params }) => {
    if (!catalog.getArtist(params.id)) throw notFound("Artist");
    enricher.refreshArtist(params.id);
    return status(true);
  });
  route.json(api.search, ({ query }) => catalog.search(query.q, query.limit));

  // ------------------------------------------------------------- playlists
  route.json(api.recordListen, ({ auth: a, body }) => history.record(a.user.id, body));
  route.json(api.listHistory, ({ auth: a, query }) => history.list(a.user.id, query.offset, query.limit));
  route.json(api.historyStats, ({ auth: a, query }) => history.stats(a.user.id, query.days, query.limit));
  route.json(api.updateMe, ({ auth: a, body }) => auth.updateMe(a.user.id, body));
  route.json(api.updateUser, ({ auth: a, params, body }) => auth.updateUser(a, params.id, body));
  route.json(api.deleteUser, ({ auth: a, params }) => auth.deleteUser(a, params.id));
  route.json(api.playingNow, ({ auth: a, body }) => {
    if (!catalog.getTrack(body.trackId)) throw notFound("Track");
    scrobbler.nowPlaying(a.user.id, body.trackId);
    return { ok: true as const };
  });
  route.json(api.getScrobbling, ({ auth: a }) => scrobbler.status(a.user.id));
  route.json(api.connectListenBrainz, ({ auth: a, body }) => scrobbler.connect(a.user.id, body.token));
  route.json(api.disconnectListenBrainz, ({ auth: a }) => scrobbler.disconnect(a.user.id, "listenbrainz"));
  route.json(api.authorizeLastfm, () => scrobbler.authorizeLastfm());
  route.json(api.connectLastfm, ({ auth: a, body }) => scrobbler.connectLastfm(a.user.id, body.token));
  route.json(api.disconnectLastfm, ({ auth: a }) => scrobbler.disconnect(a.user.id, "lastfm"));
  route.json(api.listPlaylists, ({ auth: a }) => playlists.list(a.user.id));
  route.json(api.createPlaylist, ({ auth: a, body }) =>
    playlists.create(a.user.id, body.name, body.description ?? null, body.trackIds),
  );
  route.json(api.getPlaylist, ({ auth: a, params }) => playlists.get(a.user.id, params.id));
  route.json(api.updatePlaylist, ({ auth: a, params, body }) => playlists.update(a.user.id, params.id, body));
  route.json(api.deletePlaylist, ({ auth: a, params }) => (playlists.delete(a.user.id, params.id), ok));
  route.json(api.addToPlaylist, ({ auth: a, params, body }) =>
    playlists.add(a.user.id, params.id, body.source, body.position),
  );
  route.json(api.removeFromPlaylist, ({ auth: a, params }) =>
    playlists.remove(a.user.id, params.id, params.entryId),
  );
  route.json(api.movePlaylistEntry, ({ auth: a, params, body }) =>
    playlists.move(a.user.id, params.id, params.entryId, body.toIndex),
  );

  // ----------------------------------------------------------------- queue
  route.json(api.getQueue, ({ auth: a }) => queues.get(who(a)));
  route.json(api.setQueue, ({ auth: a, body }) => queues.set(who(a), body.source, body.start, body.shuffle));
  route.json(api.updateQueue, ({ auth: a, body }) => queues.update(who(a), body));
  route.json(api.clearQueue, ({ auth: a }) => queues.clear(who(a)));
  route.json(api.addToQueue, ({ auth: a, body }) => queues.add(who(a), body.source, body.placement));
  route.json(api.removeFromQueue, ({ auth: a, params }) => queues.remove(who(a), params.entryId));
  route.json(api.advanceQueue, ({ auth: a, body }) => queues.advance(who(a), body.auto));
  route.json(api.rewindQueue, ({ auth: a }) => queues.back(who(a)));
  route.json(api.jumpInQueue, ({ auth: a, body }) => queues.jump(who(a), body.entryId));

  route.binary(api.stream, async ({ params, query, request, reply }) => {
    const track = catalog.trackPath(params.id);
    if (!track) throw notFound("Track");
    const limit = (s: Readable) => (config.debugThrottleKbps ? throttle(s, config.debugThrottleKbps) : s);
    if (query.format !== "original") {
      const t = await transcode(config.ffmpeg, track.path, query.format, query.bitrate, query.start).catch(
        (err: unknown) => {
          throw err instanceof TranscodeError ? new HttpError(502, "transcode_failed", err.message) : err;
        },
      );
      request.raw.on("close", t.kill);
      return reply.header("Content-Type", t.mime).header("Cache-Control", "no-store").send(limit(t.stream));
    }
    const range = parseRange(request.headers.range, track.fileSize);
    reply.header("Accept-Ranges", "bytes").header("Content-Type", mimeForContainer(track.container));
    if (range === "unsatisfiable") {
      return reply.status(416).header("Content-Range", `bytes */${track.fileSize}`).send();
    }
    if (range) {
      return reply
        .status(206)
        .header("Content-Range", `bytes ${range.start}-${range.end}/${track.fileSize}`)
        .header("Content-Length", range.end - range.start + 1)
        .send(limit(openFile(track.path, range)));
    }
    return reply.header("Content-Length", track.fileSize).send(limit(openFile(track.path)));
  });

  route.binary(api.artwork, async ({ params, query, reply }) => {
    const art = catalog.artworkPath(params.id);
    if (!art) throw notFound("Artwork");
    // Private: artwork now requires a session, so shared caches must not keep it.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    if (!query.size) return reply.header("Content-Type", art.mime).send(await readFile(art.path));
    const resized = await sharp(art.path)
      .resize(query.size, query.size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return reply.header("Content-Type", "image/webp").send(resized);
  });

  app.get("/openapi.json", () => openApiDocument());
  app.addHook("onClose", () => {
    enricher.stop();
    db.close();
  });

  return { app, startScan, auth, scrobbler, tls, folders };
}

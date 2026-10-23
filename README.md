# HyperPlayer

Client–server music player.

| Path               | What                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `packages/schemas` | Zod models + HTTP API contract. **Single source of truth for every type.**                                   |
| `apps/server`      | Node/TypeScript server (Fastify, `node:sqlite`): library scan, catalog, artwork, streaming, ffmpeg transcode |
| `apps/client`      | Native client in Rust + Slint, audio via rodio/symphonia                                                     |
| `api/`             | Generated `schema.json` (→ Rust types via typify) and `openapi.json`. Do not edit.                           |

## How types flow

```
packages/schemas (Zod) ──► server: validates params/query/responses at runtime, types handlers at compile time
         │
         └─ vp run @hyperplayer/schemas#generate ──► api/schema.json ──► apps/client/build.rs (typify) ──► Rust structs
```

Change a schema, and the server stops type-checking and the client stops compiling until both match.

## Requirements

- [Vite+](https://viteplus.dev) (`vp`), Node ≥ 22.18, Rust (rustup)
- Linux: `libfontconfig-dev libasound2-dev ffmpeg`

## Commands

```bash
vp install
vp run dev             # generate types, then run server + client together
vp run server          # server only (HP_LIBRARY=~/Music by default)
vp run client          # client only (HP_SERVER=http://127.0.0.1:4533 by default)
vp run ready           # fmt + lint + typecheck + all tests + clippy + release build
```

Server environment: `HP_LIBRARY`, `HP_DATA_DIR` (default `apps/server/.data`), `HP_HOST`, `HP_PORT` (4533),
`HP_FFMPEG`, `HP_VALIDATE_RESPONSES`. The OpenAPI document is served at `/openapi.json`.

## Enrichment

After each scan the server fetches, in the background (MusicBrainz allows 1 request/s; the playing track
jumps the queue):

- **Per-track credits** from one MusicBrainz release lookup per album: performers and instruments per
  recording, writers per work, producers/engineers per release. Files tagged by Picard/Lidarr are matched by
  release and recording id; untagged albums are searched. If the library's edition has no credits (common for
  reissues), credits are taken from another edition of the same release group.
- **File tags** (`PERFORMER`, `TMCL`, composer, producer, …) are used until/unless MusicBrainz has credits.
- **Artist profiles**: type, origin, years, band members and links (MusicBrainz); biography (Wikipedia, via
  Wikidata); photo (Wikimedia Commons, or fanart.tv with a key, which also provides banners).

Settings: `HP_ENRICH` (default `true`), `HP_CONTACT` (sent in the User-Agent as MusicBrainz requests),
`HP_WIKI_LANG` (biography language, falls back to English), `HP_FANART_KEY`.

## Streaming

The client plays while it downloads (bounded read-ahead; seeks in originals use HTTP Range requests) and
decodes on its own thread, so a slow network never blocks the audio device.

In **Auto** mode it measures throughput while prebuffering and picks the best stream the link sustains:
the original file, or an ffmpeg transcode to Ogg Vorbis at 320/192/128/96/64 kbit/s (lossy sources are never
re-encoded upwards). During playback it steps down, resuming at the same position, when the download lags
the bitrate or audio underruns. The mode chip in the player cycles Auto → Original → Data saver (≤128 kbit/s).

- Client: `HP_QUALITY=original|data-saver` sets the initial mode.
- Server: `HP_DEBUG_THROTTLE_KBPS` caps every stream, to exercise adaptation on a fast network.
- `cargo run --example stream_probe -- "<title>" <seconds> [original]` (in `apps/client`) plays a track
  headlessly and logs quality decisions, throughput, memory and underruns.

## Search, playlists and the play queue

- **Search** uses an SQLite FTS5 index: every word must match (as a prefix) in a title, artist or album
  name, or a credited musician ("coltrane" finds every track he plays on). Case and accents are ignored;
  an entity's own name ranks above what it belongs to, which ranks above credits.
- **Playlists** live on the server. Entries store a snapshot (title, artist, album, MusicBrainz recording)
  next to the track id, so moving files or rescanning relinks them instead of dropping them.
- **The play queue** lives on the server too, one per device: the client generates a device id
  (`~/.config/hyperplayer/settings.json`, which also keeps volume and quality mode) and sends every
  navigation (next, previous, jump, shuffle, repeat) to `/api/devices/{device}/queue`. The queue and the
  playback position survive restarts of either side.
- **Safety:** a scan never removes tracks when the library folder is missing or reads as empty
  (e.g. an unmounted network share).

## Accounts and security

- Every endpoint declares its access level in the contract (`public`, `session`, `user` or `admin`, defaulting to `user`);
  the router enforces it, a schema test pins the public set to sign-in only (and the `session` set, usable before
  replacing a default password, to me/change-password/sign-out), and a server test calls every other endpoint
  anonymously to check it answers 401.
- **First start:** the server creates `admin` with the default password `hyperplayer` (override with
  `HP_DEFAULT_ADMIN_PASSWORD`, e.g. from an installer). Signing in with it works, but that session can only read
  `/api/me`, change the password or sign out; everything else answers `password_change_required` until a new
  password is set, after which the default stops working. Playlists without an owner are adopted by the first admin.
- **Devices:** signing in creates a device with a random 256-bit token (`Authorization: Bearer`). The server
  stores only its SHA-256; passwords are Argon2id. Devices can be listed and revoked; changing the password signs
  out all other devices. Failed sign-ins are rate-limited per IP and per username.
- **Client:** the token is kept in the OS keyring (Secret Service on Linux), falling back to a `0600` file.
- **Browsers (future web client):** sign-in can set an `HttpOnly; SameSite=Strict; Secure` cookie instead;
  cookie-authenticated writes must carry a same-origin `Origin` (CSRF protection). Cross-origin access is off
  unless listed in `HP_CORS_ORIGINS`.
- **TLS:** tokens are only as safe as the connection. Keep the server on a trusted LAN, or put it behind an HTTPS
  reverse proxy (set `HP_TRUST_PROXY=true` there, so rate limits see real client IPs). `HP_SECURE_COOKIES=false`
  is for plain-HTTP development only.

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

## Installing

`packaging/linux/build-release.sh` builds `release/hyperplayer-<version>-linux-x64.tar.gz`: the bundled
server with its own Node.js, the Docker build files, the systemd unit, the player's `.deb`, and
`install.sh`. Unpack it on the target machine and run `sudo ./install.sh`, a wizard that installs the server,
the player or both:

- The server runs either in Docker (the image is built on the host from the bundle) or as a systemd
  service. Either way it runs as the `hyperplayer` user, reads its settings from `/etc/hyperplayer/server.env`
  and keeps its data in `/var/lib/hyperplayer`, so switching between the two keeps the library and accounts.
- In Docker, the container can mount SMB shares itself (read-only); their credentials stay in
  `/etc/hyperplayer` and `/opt/hyperplayer/compose.yaml`, readable by root only. Docker in an unprivileged
  Proxmox LXC can't mount SMB: mount the share on the Proxmox host and pass the folder in instead.
- Running it again upgrades in place (keeping the settings, or changing them); `--uninstall` removes it.

The `.deb` is built against the build machine's libraries, so it installs on that distribution release or
newer. The player is also a Flatpak (`packaging/flatpak/build.sh`, included in the bundle when Flathub's
`org.flatpak.Builder` is installed), which runs on any distribution: the wizard offers it where there's no
apt, or the `.deb` doesn't fit. On its own: `flatpak install --user hyperplayer-<version>-x86_64.flatpak`.

## HTTPS

`HP_TLS` (`auto` by default) serves HTTPS whenever the server listens beyond this machine, and plain HTTP
when it only listens on `127.0.0.1` (development). `on` and `off` force it either way; use `off` behind a
reverse proxy that does HTTPS.

- With `HP_TLS_CERT` and `HP_TLS_KEY` (PEM files, e.g. from Let's Encrypt), the server uses them and picks
  up renewed files within an hour, without a restart.
- Without them it makes a self-signed certificate in `HP_DATA_DIR/tls`, valid for 10 years and naming the
  host, its addresses and any extra `HP_TLS_NAMES` (comma-separated). It logs the certificate's SHA-256
  fingerprint at startup.

The client trusts certificates from public authorities as usual. The first time it meets a self-signed one,
it shows the fingerprint and asks whether to trust it (compare it with the server's log); from then on it
accepts only that certificate for that server. Trusted fingerprints are kept in
`~/.config/hyperplayer/trusted-servers.json`. A server address typed without `https://` or `http://` uses
HTTPS, except `localhost` and `127.0.0.1`.

## Library folders

`HP_LIBRARY` lists one or more music folders, separated like `PATH`
(`HP_LIBRARY=/mnt/storage/Music:/home/me/Music`). They make one library, kept current without restarts:

- **Periodic rescans** (`HP_RESCAN_MINUTES`, default 5; 0 disables) work on every filesystem, including
  network shares (SMB/CIFS, NFS), which don't report changes made on the server side. They're cheap:
  unchanged files are only `stat`ed (a 14,000-track share rescans in under a second).
- **Watching** (`HP_WATCH`, on by default) picks local changes up within seconds where the filesystem
  reports them. Folders that can't be watched (missing, unsupported) fall back to the rescans, and
  watching starts once they appear.
- A folder that is **missing or reads as empty** (an unmounted share or drive) keeps its tracks, so queues,
  playlists and history survive until it's back. A folder removed from `HP_LIBRARY` takes its tracks with it.
- Files modified in the last few seconds are left for the next scan, so half-copied files aren't read.

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

## Scrobbling

Each user can send their listens to ListenBrainz (with their user token) and Last.fm (allowed in the
browser from Settings). Listens are queued on the server and retried until the service has them.

Last.fm needs an API account for the server: create one at https://www.last.fm/api/account/create and set
`HP_LASTFM_API_KEY` and `HP_LASTFM_SECRET`. Without them, Last.fm shows as unavailable.

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

## Desktop integration

The client registers as an MPRIS player (`org.mpris.MediaPlayer2.hyperplayer`) via souvlaki's pure-Rust D-Bus
backend: media keys, headset buttons, KDE Connect/GSConnect and the GNOME/KDE media widgets can play, pause, skip
and seek, and show title, artist, album, duration and cover. Covers are cached as JPEG under
`~/.cache/hyperplayer/covers` because desktop shells can't fetch the authenticated artwork URLs. The same crate
provides the macOS and Windows media controls.

## ReplayGain

The scanner reads ReplayGain track/album gain and peak tags and serves them with every track. The client applies
the gain in its audio pipeline (instantly, not after the buffer), capped by the tagged peak so boosts never clip.
Modes, a per-user preference cycled by the **RG** chip: _Auto_ (album gain while an album plays in order, track
gain when shuffling or mixing), _Track_, _Album_, _Off_; plus a pre-amp (`replayGainPreamp`, ±15 dB). Untagged
files play unchanged.

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

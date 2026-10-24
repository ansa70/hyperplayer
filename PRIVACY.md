# Privacy policy

HyperPlayer sends nothing about you or what you listen to anywhere you haven't chosen. It has no
telemetry, no analytics, no accounts with us and no ads.

## The player

The player connects only to the HyperPlayer server you enter. Its settings and the server's sign-in token
stay on your computer (the token in the system's keyring).

## The server

The server keeps your library, accounts, playlists and listening history on its own disk. To show
credits, artist biographies and photos, cover art and lyrics, it looks up the artists, albums and tracks
in your library at these services:

| Service                                             | For                                        |
| --------------------------------------------------- | ------------------------------------------ |
| [MusicBrainz](https://musicbrainz.org)              | credits, artist profiles, release matching |
| [Cover Art Archive](https://coverartarchive.org)    | cover art for albums without any           |
| [Wikidata](https://www.wikidata.org), Wikipedia     | artist biographies                         |
| [Wikimedia Commons](https://commons.wikimedia.org)  | artist photos                              |
| [LRCLIB](https://lrclib.net)                        | lyrics                                     |
| [fanart.tv](https://fanart.tv), only with a key set | artist photos and banners                  |

These lookups send artist names, album and track titles, track lengths and MusicBrainz ids, plus the
server's internet address, as any web request does, and a User-Agent naming HyperPlayer, its version and
a contact (`HP_CONTACT`, by default HyperPlayer's GitHub page), as MusicBrainz asks. They never include
accounts, usernames or listening history. Each service handles requests under its own privacy policy.

The lookups can be turned off: uncheck **Look up artist info, artwork and lyrics online** in the Windows
installer, or set `HP_ENRICH=false` in the server's settings (`server.env`) and restart it. Without them
the server uses only what's in your files' tags, and shows no lyrics.

## Scrobbling

Each user can choose to send what they listen to (track, artist, album, time) to
[ListenBrainz](https://listenbrainz.org) or [Last.fm](https://www.last.fm), with their own account, in
**Settings**. Nothing is sent until that user turns it on, and it stops when they turn it off.

## Questions

Open an issue at https://github.com/ansa70/hyperplayer/issues.

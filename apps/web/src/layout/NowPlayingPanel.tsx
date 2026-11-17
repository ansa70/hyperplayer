import type { NowPlaying } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, call } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { usePlayer } from "../stores/player.ts";

/** How often, and how many times, to ask again while the server is still looking details up. */
const POLL_EVERY = 2000;
const POLLS = 30;

/** The playing track's details: credits, the artist and more by them; refreshed while being looked up. */
export function useNowPlaying(): NowPlaying | null {
  const trackId = usePlayer((s) => s.track?.id);
  const [np, setNp] = useState<NowPlaying | null>(null);
  useEffect(() => {
    setNp(null);
    if (!trackId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = (polls: number) => {
      call(api.nowPlaying, { params: { id: trackId } })
        .then((data) => {
          if (stop) return;
          setNp(data);
          if (data.enrichment === "pending" && polls < POLLS)
            timer = setTimeout(() => load(polls + 1), POLL_EVERY);
        })
        .catch(() => {});
    };
    load(0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [trackId]);
  return np;
}

function artistMeta(np: NowPlaying): string {
  const a = np.artist;
  const kind = a.kind && a.kind !== "other" ? a.kind[0]!.toUpperCase() + a.kind.slice(1) : null;
  return [kind, a.area, a.activeYears].filter(Boolean).join(" · ");
}

/** The desktop's right-hand panel, like the Rust player's: what's playing, its credits and artist. */
export function NowPlayingPanel() {
  const track = usePlayer((s) => s.track);
  const np = useNowPlaying();
  if (!track) {
    return (
      <aside className="now-playing">
        <div className="faint now-playing-empty">Nothing playing</div>
      </aside>
    );
  }
  const details = np?.track.id === track.id ? np : null;
  const pending = details?.enrichment === "pending";
  const f = track.format;
  return (
    <aside className="now-playing">
      <div className="caps">Now playing</div>
      <Cover art={track.cover} size={312} className="now-playing-cover" />
      <div className="now-playing-title">{track.title}</div>
      <Link to={`/artist/${track.artistId}`} className="now-playing-artist">
        {track.artistName}
      </Link>
      <Link to={`/album/${track.albumId}`} className="muted">
        {track.albumTitle}
        {track.year ? ` · ${track.year}` : ""}
      </Link>
      <div className="np-chips">
        <span className="chip static">{f.codec.toUpperCase()}</span>
        {f.lossless && f.sampleRate && (
          <span className="chip static">
            {f.bitDepth ? `${f.bitDepth}-bit ` : ""}
            {f.sampleRate / 1000} kHz
          </span>
        )}
      </div>
      {details && details.artist.genres.length > 0 && (
        <div className="muted np-small">{details.artist.genres.join(" · ")}</div>
      )}

      <h3>Credits</h3>
      {!details || details.credits.length === 0 ? (
        <div className="faint np-small">
          {!details || pending ? "Looking up musicians…" : "No credits found for this track."}
        </div>
      ) : (
        <div className="credits">
          {details.credits.map((c, i) => (
            // The same person can be credited more than once (track and album, or in two categories).
            <div key={`${i}-${c.name}`} className="credit">
              {c.artistId ? <Link to={`/artist/${c.artistId}`}>{c.name}</Link> : <span>{c.name}</span>}
              <span className="faint">{c.roles.join(", ")}</span>
            </div>
          ))}
        </div>
      )}

      {details && (
        <>
          <h3>About {details.artist.name}</h3>
          {artistMeta(details) && <div className="muted np-small">{artistMeta(details)}</div>}
          <p className="np-bio muted">
            {details.artist.biography ?? (pending ? "Fetching biography…" : "No biography available.")}
          </p>
          {details.artist.members.length > 0 && (
            <div className="credits">
              {details.artist.members.map((m, i) => (
                <div key={`${i}-${m.name}`} className="credit">
                  {m.artistId ? <Link to={`/artist/${m.artistId}`}>{m.name}</Link> : <span>{m.name}</span>}
                  <span className="faint">{[m.roles.join(", "), m.years].filter(Boolean).join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
          {details.moreFromArtist.length > 0 && (
            <>
              <h3>More from {details.artist.name}</h3>
              <div className="more-from">
                {details.moreFromArtist.slice(0, 6).map((a) => (
                  <Link key={a.id} to={`/album/${a.id}`} className="more-from-album" title={a.title}>
                    <Cover art={a.cover} size={96} />
                    <span className="ellipsis">{a.title}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

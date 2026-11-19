import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api.ts";
import { AlbumGrid } from "../components/AlbumGrid.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { TrackList } from "../components/TrackList.tsx";
import { queueAndPlaylistItems } from "../components/trackActions.ts";
import { ArtistRow } from "../layout/Sidebar.tsx";
import { usePhone } from "../layout/Shell.tsx";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";
import { t, tn } from "../i18n.ts";

/** Artists, albums, tracks and genres matching `?q=`; on phones, with its own search box. */
export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const phone = usePhone();
  return (
    <div className="page">
      {phone && (
        <input
          className="search-input"
          type="search"
          placeholder={t("Search artists, albums, tracks")}
          autoFocus={!q}
          defaultValue={q}
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
        />
      )}
      {q.trim() ? <Results q={q.trim()} /> : <p className="muted">{t("Type to search the library.")}</p>}
    </div>
  );
}

function Results({ q }: { q: string }) {
  // Wait for a pause in typing.
  const [query, setQuery] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error } = useApi(api.search, { query: { q: query, limit: 30 } });
  const play = usePlayer((s) => s.play);
  if (error) return <p className="muted">{error}</p>;
  if (!data) return null;
  const nothing = !data.artists.length && !data.albums.length && !data.tracks.length && !data.genres.length;
  if (nothing) return <p className="muted">Nothing matches “{query}”.</p>;
  const trackIds = data.tracks.map((t) => t.id);
  return (
    <>
      {data.tracks.length > 0 && (
        <>
          <div className="caps section">{t("Tracks")}</div>
          <TrackList tracks={data.tracks} onPlay={(i) => void play({ kind: "tracks", trackIds }, i, false)} />
        </>
      )}
      {data.artists.length > 0 && (
        <>
          <div className="caps section">{t("Artists")}</div>
          <div className="search-artists">
            {data.artists.map((a) => (
              <ArtistRow key={a.id} artist={a} />
            ))}
          </div>
        </>
      )}
      {data.albums.length > 0 && (
        <>
          <div className="caps section">{t("Albums")}</div>
          <AlbumGrid albums={data.albums} />
        </>
      )}
      {data.genres.length > 0 && (
        <>
          <div className="caps section">{t("Genres")}</div>
          <div className="genres">
            {data.genres.map((g) => (
              <div key={g.name} className="genre">
                <button
                  onClick={() => void play({ kind: "genre", name: g.name }, 0, true)}
                  title={t("Shuffle this genre")}
                >
                  {g.name} <span className="faint">{tn("{n} track", "{n} tracks", g.trackCount)}</span>
                </button>
                <MenuButton items={() => queueAndPlaylistItems({ kind: "genre", name: g.name }, g.name)} />
              </div>
            ))}
          </div>
        </>
      )}
      <p className="faint search-more">
        {t("Looking for something else?")} <Link to="/albums">{t("Browse all albums")}</Link>
      </p>
    </>
  );
}

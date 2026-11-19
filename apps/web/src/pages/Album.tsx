import { Link, useParams } from "react-router";
import { api } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { queueAndPlaylistItems } from "../components/trackActions.ts";
import { TrackList } from "../components/TrackList.tsx";
import { duration } from "../format.ts";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";
import { t, tn } from "../i18n.ts";

export function Album() {
  const { id = "" } = useParams();
  const { data: album, error } = useApi(api.getAlbum, { params: { id } });
  const play = usePlayer((s) => s.play);
  if (error) return <div className="page muted">{error}</div>;
  if (!album) return <div className="page" />;
  const source = { kind: "album", id } as const;
  return (
    <div className="page">
      <header className="hero">
        <Cover art={album.cover} size={200} />
        <div className="hero-text">
          <div className="caps">{t("Album")}</div>
          <h1>{album.title}</h1>
          <Link to={`/artist/${album.artistId}`} className="hero-artist">
            {album.artistName}
          </Link>
          <div className="muted">
            {[album.year, tn("{n} track", "{n} tracks", album.trackCount), duration(album.durationMs)]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {album.genres.length > 0 && <div className="faint">{album.genres.join(" · ")}</div>}
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void play(source, 0, false)}>
              <Icon name="play" size={16} /> {t("Play")}
            </button>
            <button className="outline-button" onClick={() => void play(source, 0, true)}>
              {t("Shuffle")}
            </button>
            <MenuButton items={() => queueAndPlaylistItems(source, album.title)} />
          </div>
        </div>
      </header>
      <TrackList tracks={album.tracks} numbered onPlay={(i) => void play(source, i, false)} />
    </div>
  );
}

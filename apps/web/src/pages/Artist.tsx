import { useParams } from "react-router";
import { api } from "../api.ts";
import { AlbumGrid } from "../components/AlbumGrid.tsx";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { queueAndPlaylistItems } from "../components/trackActions.ts";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";
import { years } from "../roles.ts";
import { t, tn } from "../i18n.ts";

export function Artist() {
  const { id = "" } = useParams();
  const artist = useApi(api.getArtist, { params: { id } });
  const albums = useApi(api.getArtistAlbums, { params: { id } });
  const play = usePlayer((s) => s.play);
  const a = artist.data;
  if (artist.error) return <div className="page muted">{artist.error}</div>;
  return (
    <div className="page">
      <header className="hero">
        <Cover art={a?.image} size={180} round />
        <div className="hero-text">
          <div className="caps">{t("Artist")}</div>
          <h1>{a?.name ?? ""}</h1>
          {a && (
            <div className="muted">
              {[
                a.area,
                a.activeYears && years(a.activeYears),
                tn("{n} album", "{n} albums", a.albumCount),
                tn("{n} track", "{n} tracks", a.trackCount),
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
          {a && a.genres.length > 0 && <div className="faint">{a.genres.slice(0, 5).join(" · ")}</div>}
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void play({ kind: "artist", id }, 0, false)}>
              <Icon name="play" size={16} /> {t("Play")}
            </button>
            <button className="outline-button" onClick={() => void play({ kind: "artist", id }, 0, true)}>
              {t("Shuffle")}
            </button>
            {a && <MenuButton items={() => queueAndPlaylistItems({ kind: "artist", id }, a.name)} />}
          </div>
        </div>
      </header>
      {a?.biography && <p className="bio muted">{a.biography}</p>}
      <div className="caps section">{t("Albums")}</div>
      <AlbumGrid albums={albums.data ?? []} showArtist={false} />
    </div>
  );
}

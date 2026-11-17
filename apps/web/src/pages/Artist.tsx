import { useParams } from "react-router";
import { api } from "../api.ts";
import { AlbumGrid } from "../components/AlbumGrid.tsx";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { plural } from "../format.ts";
import { usePlayer } from "../stores/player.ts";
import { useApi } from "../useApi.ts";
import "./pages.css";

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
          <div className="caps">Artist</div>
          <h1>{a?.name ?? ""}</h1>
          {a && (
            <div className="muted">
              {[a.area, a.activeYears, plural(a.albumCount, "album"), plural(a.trackCount, "track")]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
          {a && a.genres.length > 0 && <div className="faint">{a.genres.slice(0, 5).join(" · ")}</div>}
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void play({ kind: "artist", id }, 0, false)}>
              <Icon name="play" size={16} /> Play
            </button>
            <button className="outline-button" onClick={() => void play({ kind: "artist", id }, 0, true)}>
              Shuffle
            </button>
          </div>
        </div>
      </header>
      {a?.biography && <p className="bio muted">{a.biography}</p>}
      <div className="caps section">Albums</div>
      <AlbumGrid albums={albums.data ?? []} showArtist={false} />
    </div>
  );
}

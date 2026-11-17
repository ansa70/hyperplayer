import type { AlbumSummary } from "@hyperplayer/schemas";
import { Link } from "react-router";
import { Cover } from "./Cover.tsx";
import "./components.css";

export function AlbumGrid({ albums, showArtist = true }: { albums: AlbumSummary[]; showArtist?: boolean }) {
  return (
    <div className="album-grid">
      {albums.map((a) => (
        <Link key={a.id} to={`/album/${a.id}`} className="album-card">
          <Cover art={a.cover} size={180} className="album-card-cover" />
          <div className="ellipsis album-card-title">{a.title}</div>
          <div className="muted ellipsis">
            {showArtist ? a.artistName : ""}
            {showArtist && a.year ? " · " : ""}
            {a.year ?? ""}
          </div>
        </Link>
      ))}
    </div>
  );
}

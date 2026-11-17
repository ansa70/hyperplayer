import { Link } from "react-router";
import { Cover } from "../components/Cover.tsx";
import { usePlayer } from "../stores/player.ts";

/** The desktop's right-hand panel: what's playing, large. */
export function NowPlayingPanel() {
  const track = usePlayer((s) => s.track);
  return (
    <aside className="now-playing">
      {track ? (
        <>
          <div className="caps">Now playing</div>
          <Cover art={track.cover} size={312} className="now-playing-cover" />
          <div className="now-playing-title">{track.title}</div>
          <Link to={`/artist/${track.artistId}`} className="muted">
            {track.artistName}
          </Link>
          <Link to={`/album/${track.albumId}`} className="faint">
            {track.albumTitle}
            {track.year ? ` · ${track.year}` : ""}
          </Link>
        </>
      ) : (
        <div className="faint now-playing-empty">Nothing playing</div>
      )}
    </aside>
  );
}

import { Link } from "react-router";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { usePlayer } from "../stores/player.ts";
import { Chips, useStreamInfo } from "./Chips.tsx";
import { Controls } from "./Controls.tsx";
import { Seek } from "./Seek.tsx";

/** The desktop player bar along the bottom of the window. */
export function TransportBar() {
  const { track, volume, setVolume, error } = usePlayer();
  const info = useStreamInfo();
  return (
    <footer className="transport">
      <div className="transport-track">
        <Cover art={track?.cover} size={56} />
        {track && (
          <div className="transport-text">
            <div className="ellipsis transport-title">{track.title}</div>
            <Link to={`/artist/${track.artistId}`} className="ellipsis muted transport-artist">
              {track.artistName}
            </Link>
          </div>
        )}
      </div>
      <div className="transport-middle">
        <Controls />
        <Seek />
      </div>
      <div className="transport-right">
        <div className="volume">
          <Icon name="volume" size={16} className="muted" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </div>
        <Chips />
        <div className={`ellipsis transport-info ${error ? "error" : "faint"}`}>{error || info}</div>
        <div className="transport-pages">
          <Link to="/lyrics" className="icon-button" title="Lyrics">
            <Icon name="lyrics" size={18} />
          </Link>
          <Link to="/queue" className="icon-button" title="Queue">
            <Icon name="queue" size={18} />
          </Link>
        </div>
      </div>
    </footer>
  );
}

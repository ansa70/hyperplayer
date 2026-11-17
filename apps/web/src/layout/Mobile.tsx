import { useEffect } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { Cover } from "../components/Cover.tsx";
import { Spectrum } from "../components/Spectrum.tsx";
import { Icon } from "../components/Icon.tsx";
import { usePlayer } from "../stores/player.ts";
import { Chips, useStreamInfo } from "./Chips.tsx";
import { Controls } from "./Controls.tsx";
import { Seek } from "./Seek.tsx";

export function TabBar() {
  return (
    <nav className="tabbar">
      <NavLink to="/" end className="tab">
        <Icon name="library" size={22} />
        Library
      </NavLink>
      <NavLink to="/search" className="tab">
        <Icon name="search" size={22} />
        Search
      </NavLink>
      <NavLink to="/playlists" className="tab">
        <Icon name="playlists" size={22} />
        Playlists
      </NavLink>
      <NavLink to="/queue" className="tab">
        <Icon name="queue" size={22} />
        Queue
      </NavLink>
    </nav>
  );
}

/** The bar above the tabs while something is loaded; tapping it opens the full player. */
export function MiniPlayer({ onOpen }: { onOpen: () => void }) {
  const { track, playing, position, toggle } = usePlayer();
  if (!track) return null;
  const progress = track.durationMs > 0 ? (position * 1000) / track.durationMs : 0;
  return (
    <div className="miniplayer" onClick={onOpen}>
      <Cover art={track.cover} size={44} />
      <div className="miniplayer-text">
        <div className="ellipsis">{track.title}</div>
        <div className="ellipsis muted">{track.artistName}</div>
      </div>
      <button
        className="icon-button"
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <Icon name={playing ? "pause" : "play"} size={24} />
      </button>
      <div className="miniplayer-progress" style={{ width: `${Math.min(1, progress) * 100}%` }} />
    </div>
  );
}

/** The full-screen player on phones. */
export function NowPlayingSheet({ onClose }: { onClose: () => void }) {
  const { track, error } = usePlayer();
  const info = useStreamInfo();
  const navigate = useNavigate();
  // The phone's back button closes it.
  useEffect(() => {
    history.pushState({ sheet: true }, "");
    const back = () => onClose();
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [onClose]);
  if (!track) return null;
  const close = () => history.back();
  // Opening a page closes the player and takes the place of its history entry: going
  // back first (as closing does) would undo the page just opened.
  const goTo = (path: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    onClose();
    void navigate(path, { replace: true });
  };
  return (
    <div className="sheet">
      <div className="sheet-top">
        <button className="icon-button" onClick={close} title="Close">
          <Icon name="chevronDown" size={26} />
        </button>
        <span className="caps">Now playing</span>
        <span>
          <Link to="/lyrics" className="icon-button" onClick={goTo("/lyrics")} title="Lyrics">
            <Icon name="lyrics" size={22} />
          </Link>
          <Link to="/queue" className="icon-button" onClick={goTo("/queue")} title="Queue">
            <Icon name="queue" size={22} />
          </Link>
        </span>
      </div>
      <Cover art={track.cover} size={600} className="sheet-cover" />
      <Spectrum height={36} />
      <div className="sheet-text">
        <div className="sheet-title ellipsis">{track.title}</div>
        <Link
          to={`/artist/${track.artistId}`}
          className="muted ellipsis"
          onClick={goTo(`/artist/${track.artistId}`)}
        >
          {track.artistName}
        </Link>
      </div>
      <Seek />
      <Controls large />
      <Chips />
      <div className={`sheet-info ${error ? "error" : "faint"}`}>{error || info}</div>
    </div>
  );
}

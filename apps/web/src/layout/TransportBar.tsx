import { Link, useLocation, useNavigate } from "react-router";
import type { IconName } from "../components/icons.ts";
import { useBack } from "./useBack.ts";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { usePlayer } from "../stores/player.ts";
import { Chips, useStreamInfo } from "./Chips.tsx";
import { Controls } from "./Controls.tsx";
import { Seek } from "./Seek.tsx";
import { t } from "../i18n.ts";
import { useRadio } from "../stores/radio.ts";
import { StationLogo } from "../pages/Radio.tsx";
import { LiveTime, RadioControls, useRadioInfo } from "./Radio.tsx";

/** The desktop player bar along the bottom of the window. */
export function TransportBar() {
  const { track, volume, setVolume, error } = usePlayer();
  const trackInfo = useStreamInfo();
  const { live, title, error: radioError } = useRadio();
  const radioInfo = useRadioInfo();
  const info = live ? radioInfo : trackInfo;
  const problem = live ? radioError : error;
  return (
    <footer className="transport">
      <div className="transport-track">
        {live ? <StationLogo station={live} size={56} /> : <Cover art={track?.cover} size={56} />}
        {live ? (
          <div className="transport-text">
            <div className="ellipsis transport-title">{title ?? live.name}</div>
            <div className="ellipsis muted transport-artist">{title ? live.name : ""}</div>
          </div>
        ) : (
          track && (
            <div className="transport-text">
              <div className="ellipsis transport-title">{track.title}</div>
              <Link to={`/artist/${track.artistId}`} className="ellipsis muted transport-artist">
                {track.artistName}
              </Link>
            </div>
          )
        )}
      </div>
      <div className="transport-middle">
        {live ? (
          <>
            <RadioControls />
            <LiveTime />
          </>
        ) : (
          <>
            <Controls />
            <Seek />
          </>
        )}
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
        <div className={`ellipsis transport-info ${problem ? "error" : "faint"}`}>{problem || info}</div>
        <div className="transport-pages">
          <PageToggle path="/lyrics" icon="lyrics" title={t("Lyrics")} closeTitle={t("Close lyrics")} />
          <PageToggle path="/queue" icon="queue" title={t("Queue")} closeTitle={t("Close the queue")} />
        </div>
      </div>
    </footer>
  );
}

/** Opens a page (lyrics, the queue), or closes it when it's open, as in the Rust player. */
function PageToggle({
  path,
  icon,
  title,
  closeTitle,
}: {
  path: string;
  icon: IconName;
  title: string;
  closeTitle: string;
}) {
  const open = useLocation().pathname === path;
  const navigate = useNavigate();
  const back = useBack();
  return (
    <button
      className={`icon-button ${open ? "active" : ""}`}
      title={open ? closeTitle : title}
      onClick={() => (open ? back() : void navigate(path))}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

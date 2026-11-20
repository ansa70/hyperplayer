import { useEffect, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { Spectrum } from "../components/Spectrum.tsx";
import { duration } from "../format.ts";
import { t } from "../i18n.ts";
import { countryName, FavouriteStar, StationLogo } from "../pages/Radio.tsx";
import { usePlayer } from "../stores/player.ts";
import { useRadio } from "../stores/radio.ts";
import "../pages/radio.css";

/** The station's state for the bar: live with the time listened, connecting, or stopped. */
export function useLiveText(): string {
  const { playing, loading, since } = useRadio();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [playing]);
  if (loading) return t("Connecting…");
  if (!playing) return t("Stopped");
  return `${t("LIVE")} · ${duration(Date.now() - since)}`;
}

/** "MP3 128k · Radio", as the bar's info line. */
export function useRadioInfo(): string {
  const live = useRadio((s) => s.live);
  if (!live) return "";
  const format = [live.codec, live.bitrate ? `${live.bitrate}k` : ""].filter(Boolean).join(" ");
  return [format, t("Radio")].filter(Boolean).join(" · ");
}

/** Play/pause for the station, and back to the queue when there's a track to go back to. */
export function RadioControls({ large }: { large?: boolean }) {
  const { playing, loading, toggle, backToQueue } = useRadio();
  const hasTrack = usePlayer((s) => s.track !== null);
  return (
    <div className={`controls radio-controls ${large ? "large" : ""}`}>
      {hasTrack && (
        <button className="icon-button" title={t("Back to the queue")} onClick={backToQueue}>
          <Icon name="toQueue" size={large ? 24 : 18} />
        </button>
      )}
      <button
        className={`icon-button primary ${loading ? "loading" : ""}`}
        title={playing ? t("Pause") : t("Play")}
        onClick={toggle}
      >
        <Icon name={playing || loading ? "pause" : "play"} size={large ? 28 : 20} />
      </button>
    </div>
  );
}

export function LiveTime() {
  return <div className="live-text">{useLiveText()}</div>;
}

/** The right-hand panel while a station plays. */
export function RadioPanel() {
  const { live, title, playing, loading, backToQueue } = useRadio();
  const hasTrack = usePlayer((s) => s.track !== null);
  if (!live) return null;
  const place = [countryName(live.countryCode, live.country), live.languages.join(", ")]
    .filter(Boolean)
    .join(" · ");
  return (
    <aside className="now-playing radio-panel">
      <div className="caps">{t("On the radio")}</div>
      <StationLogo station={live} size={312} className="now-playing-cover" />
      <Spectrum />
      {title && <div className="now-playing-title">{title}</div>}
      <div className="radio-panel-name">
        <div className={title ? "now-playing-artist" : "now-playing-title"}>{live.name}</div>
        <FavouriteStar station={live} />
      </div>
      <div className="radio-panel-actions">
        <span className="chip static">{loading ? t("Connecting…") : playing ? t("LIVE") : t("Stopped")}</span>
        {hasTrack && (
          <button className="outline-button" onClick={backToQueue}>
            {t("Back to the queue")}
          </button>
        )}
      </div>
      {place && <div className="muted np-small">{place}</div>}
      {live.tags.length > 0 && <div className="muted np-small">{live.tags.join(" · ")}</div>}
      {live.homepage && (
        <a href={live.homepage} target="_blank" rel="noreferrer noopener" className="np-small accent-link">
          {t("Station's website")}
        </a>
      )}
    </aside>
  );
}

import { Icon } from "../components/Icon.tsx";
import { usePlayer } from "../stores/player.ts";
import { ShuffleButton } from "./ShuffleButton.tsx";
import { t } from "../i18n.ts";

/** Shuffle, previous, play/pause, next and repeat, as in the Rust player's transport bar. */
export function Controls({ large }: { large?: boolean }) {
  const { playing, loading, queue, toggle, next, previous, cycleRepeat } = usePlayer();
  const repeat = queue?.repeat ?? "off";
  return (
    <div className={`controls ${large ? "large" : ""}`}>
      <ShuffleButton large={large} />
      <button className="icon-button" title={t("Previous")} onClick={() => void previous()}>
        <Icon name="previous" size={large ? 26 : 20} />
      </button>
      <button
        className={`icon-button primary ${loading ? "loading" : ""}`}
        title={playing ? t("Pause") : t("Play")}
        onClick={toggle}
      >
        <Icon name={playing ? "pause" : "play"} size={large ? 28 : 20} />
      </button>
      <button className="icon-button" title={t("Next")} onClick={() => void next()}>
        <Icon name="next" size={large ? 26 : 20} />
      </button>
      <button
        className={`icon-button ${repeat !== "off" ? "active" : ""}`}
        title={repeat === "one" ? t("Repeat: one") : repeat === "all" ? t("Repeat: all") : t("Repeat: off")}
        onClick={() => void cycleRepeat()}
      >
        <Icon name={repeat === "one" ? "repeatOne" : "repeat"} size={large ? 22 : 18} />
      </button>
    </div>
  );
}

import { Icon } from "../components/Icon.tsx";
import { usePlayer } from "../stores/player.ts";

/** Shuffle, previous, play/pause, next and repeat, as in the Rust player's transport bar. */
export function Controls({ large }: { large?: boolean }) {
  const { playing, loading, queue, toggle, next, previous, toggleShuffle, cycleRepeat } = usePlayer();
  const repeat = queue?.repeat ?? "off";
  return (
    <div className={`controls ${large ? "large" : ""}`}>
      <button
        className={`icon-button ${queue?.shuffle ? "active" : ""}`}
        title="Shuffle"
        onClick={() => void toggleShuffle()}
      >
        <Icon name="shuffle" size={large ? 22 : 18} />
      </button>
      <button className="icon-button" title="Previous" onClick={() => void previous()}>
        <Icon name="previous" size={large ? 26 : 20} />
      </button>
      <button
        className={`icon-button primary ${loading ? "loading" : ""}`}
        title={playing ? "Pause" : "Play"}
        onClick={toggle}
      >
        <Icon name={playing ? "pause" : "play"} size={large ? 28 : 20} />
      </button>
      <button className="icon-button" title="Next" onClick={() => void next()}>
        <Icon name="next" size={large ? 26 : 20} />
      </button>
      <button
        className={`icon-button ${repeat !== "off" ? "active" : ""}`}
        title={`Repeat: ${repeat}`}
        onClick={() => void cycleRepeat()}
      >
        <Icon name={repeat === "one" ? "repeatOne" : "repeat"} size={large ? 22 : 18} />
      </button>
    </div>
  );
}

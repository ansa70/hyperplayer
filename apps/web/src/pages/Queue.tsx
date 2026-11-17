import { Link } from "react-router";
import { Cover } from "../components/Cover.tsx";
import { duration } from "../format.ts";
import { usePlayer } from "../stores/player.ts";
import "./pages.css";

/** What's playing and what comes next; tap an entry to play it. */
export function Queue() {
  const { queue, jump } = usePlayer();
  const entries = queue?.entries ?? [];
  const index = queue?.index ?? -1;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Queue</h1>
      </div>
      {queue?.origin?.name && <div className="muted section">Playing from {queue.origin.name}</div>}
      {entries.length === 0 && <p className="muted">The queue is empty. Play an album to start.</p>}
      <div className="queue">
        {entries.map((e, i) => (
          <button
            key={e.entryId}
            className={`queue-row ${i === index ? "playing" : ""} ${i < index ? "past" : ""}`}
            onClick={() => void jump(e.entryId)}
          >
            <Cover art={e.track.cover} size={40} />
            <span className="queue-text">
              <span className="ellipsis">{e.track.title}</span>
              <span className="muted ellipsis">
                <Link to={`/artist/${e.track.artistId}`} onClick={(ev) => ev.stopPropagation()}>
                  {e.track.artistName}
                </Link>
              </span>
            </span>
            <span className="muted">{duration(e.track.durationMs)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { Link } from "react-router";
import { api, call, errorMessage } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { duration } from "../format.ts";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import "./pages.css";

/** What's playing and what comes next; tap an entry to play it. */
export function Queue() {
  const { queue, jump } = usePlayer();
  const notify = useLibrary((s) => s.notify);
  const entries = queue?.entries ?? [];
  const index = queue?.index ?? -1;
  const update = (op: Promise<NonNullable<typeof queue>>) =>
    op.then((q) => usePlayer.setState({ queue: q })).catch((e: unknown) => notify(errorMessage(e)));
  return (
    <div className="page">
      <div className="page-head">
        <h1>Queue</h1>
        {entries.length > 0 && (
          <button className="outline-button" onClick={() => void update(call(api.clearQueue))}>
            Clear
          </button>
        )}
      </div>
      {queue?.origin?.name && <div className="muted section">Playing from {queue.origin.name}</div>}
      {entries.length === 0 && <p className="muted">The queue is empty. Play an album to start.</p>}
      <div className="queue">
        {entries.map((e, i) => (
          <div
            key={e.entryId}
            role="button"
            tabIndex={0}
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
            {i !== index ? (
              <MenuButton
                items={() => [
                  {
                    label: "Remove from queue",
                    onSelect: () =>
                      void update(call(api.removeFromQueue, { params: { entryId: e.entryId } })),
                  },
                ]}
              />
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

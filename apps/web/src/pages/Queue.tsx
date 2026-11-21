import { Link } from "react-router";
import { api, call, errorMessage } from "../api.ts";
import { BackButton } from "../components/BackButton.tsx";
import { Cover } from "../components/Cover.tsx";
import { useRef } from "react";
import { MenuButton, type MenuHandle } from "../components/Menu.tsx";
import { TrackMarks } from "../components/TrackList.tsx";
import { markItems } from "../components/trackActions.ts";
import { duration } from "../format.ts";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import "./pages.css";
import { t } from "../i18n.ts";

/** What's playing and what comes next; tap an entry to play it. */
export function Queue() {
  const { queue, jump } = usePlayer();
  const notify = useLibrary((s) => s.notify);
  const entries = queue?.entries ?? [];
  const index = queue?.index ?? -1;
  // Each row's menu, opened by a right-click anywhere on the row.
  const menus = useRef(new Map<string, MenuHandle>());
  const update = (op: Promise<NonNullable<typeof queue>>) =>
    op.then((q) => usePlayer.setState({ queue: q })).catch((e: unknown) => notify(errorMessage(e)));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Queue")}</h1>
        <div className="row-actions">
          {entries.length > 0 && (
            <button className="outline-button" onClick={() => void update(call(api.clearQueue))}>
              {t("Clear")}
            </button>
          )}
          <BackButton title={t("Close the queue")} />
        </div>
      </div>
      {queue?.origin?.name && <div className="muted section">Playing from {queue.origin.name}</div>}
      {entries.length === 0 && <p className="muted">{t("The queue is empty. Play an album to start.")}</p>}
      <div className="queue">
        {entries.map((e, i) => (
          <div
            key={e.entryId}
            role="button"
            tabIndex={0}
            className={`queue-row ${i === index ? "playing" : ""} ${i < index ? "past" : ""}`}
            onClick={() => void jump(e.entryId)}
            onContextMenu={(ev) => {
              const menu = menus.current.get(e.entryId);
              if (!menu) return;
              ev.preventDefault();
              menu.open();
            }}
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
            <span className="muted track-duration">
              <TrackMarks track={e.track} />
              {duration(e.track.durationMs)}
            </span>
            <MenuButton
              handle={(m) => {
                if (m) menus.current.set(e.entryId, m);
                else menus.current.delete(e.entryId);
              }}
              items={() => [
                ...(i !== index
                  ? [
                      {
                        label: t("Remove from queue"),
                        onSelect: () =>
                          void update(call(api.removeFromQueue, { params: { entryId: e.entryId } })),
                      },
                    ]
                  : []),
                ...markItems(e.track),
              ]}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

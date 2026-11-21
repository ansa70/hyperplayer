import type { Track } from "@hyperplayer/schemas";
import { useRef } from "react";
import { Link, useNavigate } from "react-router";
import { duration } from "../format.ts";
import { useTrackMarks } from "../stores/marks.ts";
import { usePlayer } from "../stores/player.ts";
import { Icon } from "./Icon.tsx";
import { MenuButton, type MenuHandle, type MenuItem } from "./Menu.tsx";
import { markItems, queueAndPlaylistItems, trackSource } from "./trackActions.ts";
import "./components.css";
import { t, tn } from "../i18n.ts";

export interface Row {
  /** Null for a playlist entry whose file is missing from the library. */
  track: Track | null;
  title: string;
  artistName: string;
  albumTitle: string;
  durationMs: number;
  key: string;
}

export const rowOf = (t: Track): Row => ({
  track: t,
  title: t.title,
  artistName: t.artistName,
  albumTitle: t.albumTitle,
  durationMs: t.durationMs,
  key: t.id,
});

/** A star for a favourite, a struck-through shuffle for a track left out of the library shuffle. */
export function TrackMarks({ track }: { track: Track | null }) {
  const marks = useTrackMarks(track);
  return (
    <>
      {marks.rating > 0 && (
        <span className="track-rating" title={tn("{n} star", "{n} stars", marks.rating)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={n <= marks.rating ? "on" : ""}>
              <Icon name="star" size={10} />
            </span>
          ))}
        </span>
      )}
      {marks.shuffleExcluded && (
        <span className="track-mark" title={t("Left out of the library shuffle")}>
          <Icon name="shuffleOff" size={13} />
        </span>
      )}
      {marks.favourite && (
        <span className="track-mark favourite" title={t("Favourite")}>
          <Icon name="star" size={13} />
        </span>
      )}
    </>
  );
}

/** Tracks of an album (numbered) or a mixed list (with their artist and album). */
export function TrackList({
  tracks,
  rows,
  onPlay,
  numbered,
  extraItems,
}: {
  tracks?: Track[];
  rows?: Row[];
  onPlay: (index: number) => void;
  numbered?: boolean;
  /** More actions for a row's menu (e.g. removing it from a playlist). */
  extraItems?: (index: number) => MenuItem[];
}) {
  const list = rows ?? (tracks ?? []).map(rowOf);
  const playingId = usePlayer((s) => s.track?.id);
  const navigate = useNavigate();
  // Each row's menu, opened by a right-click anywhere on the row.
  const menus = useRef(new Map<string, MenuHandle>());
  // Disc headings only on an album's own list.
  const discs = numbered === true && new Set(list.map((r) => r.track?.discNumber ?? 1)).size > 1;
  return (
    <div className="tracklist">
      {list.map((r, i) => {
        const track = r.track;
        const playing = track !== null && track.id === playingId;
        const newDisc = discs && (i === 0 || list[i - 1]!.track?.discNumber !== track?.discNumber);
        return (
          <div key={r.key}>
            {newDisc && <div className="caps disc">{t("Disc {}", track?.discNumber ?? 1)}</div>}
            <div
              className={`track ${playing ? "playing" : ""} ${track ? "" : "missing"}`}
              role="button"
              tabIndex={0}
              onClick={() => track && onPlay(i)}
              onKeyDown={(e) => e.key === "Enter" && track && onPlay(i)}
              onContextMenu={(e) => {
                const menu = menus.current.get(r.key);
                if (!menu) return;
                e.preventDefault();
                menu.open();
              }}
            >
              <span className="track-number">{numbered ? (track?.trackNumber ?? i + 1) : i + 1}</span>
              <span className="track-title">
                <span className="ellipsis">{r.title}</span>
                {!numbered && (
                  <span className="muted ellipsis track-sub">
                    {track ? (
                      <>
                        <Link to={`/artist/${track.artistId}`} onClick={(e) => e.stopPropagation()}>
                          {r.artistName}
                        </Link>
                        {" · "}
                        <Link to={`/album/${track.albumId}`} onClick={(e) => e.stopPropagation()}>
                          {r.albumTitle}
                        </Link>
                      </>
                    ) : (
                      t("{} · {} · not in the library", r.artistName, r.albumTitle)
                    )}
                  </span>
                )}
              </span>
              <span className="muted track-duration">
                <TrackMarks track={track} />
                {duration(r.durationMs)}
              </span>
              <MenuButton
                handle={(m) => {
                  if (m) menus.current.set(r.key, m);
                  else menus.current.delete(r.key);
                }}
                items={() => [
                  ...(track ? queueAndPlaylistItems(trackSource(track), track.title) : []),
                  ...(track ? markItems(track) : []),
                  ...(track && !numbered
                    ? [{ label: t("Go to album"), onSelect: () => void navigate(`/album/${track.albumId}`) }]
                    : []),
                  ...(track
                    ? [
                        {
                          label: t("Go to artist"),
                          onSelect: () => void navigate(`/artist/${track.artistId}`),
                        },
                      ]
                    : []),
                  ...(extraItems?.(i) ?? []),
                ]}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

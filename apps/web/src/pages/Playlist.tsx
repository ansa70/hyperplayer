import type { Playlist as PlaylistData, TrackSource } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, call, errorMessage } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { Mosaic } from "../components/Mosaic.tsx";
import { TrackList, type Row } from "../components/TrackList.tsx";
import { queueAndPlaylistItems } from "../components/trackActions.ts";
import { duration, plural } from "../format.ts";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import "./pages.css";

/** The playlist as shown: a smart one's rules may pick differently each time, so it plays what's on screen. */
function shown(p: PlaylistData): TrackSource {
  return {
    kind: "playlist",
    id: p.id,
    trackIds: p.rules ? p.entries.flatMap((e) => (e.track ? [e.track.id] : [])) : undefined,
  };
}

export function Playlist() {
  const { id = "" } = useParams();
  const [p, setP] = useState<PlaylistData | null>(null);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const play = usePlayer((s) => s.play);
  const { loadPlaylists, notify } = useLibrary();
  const navigate = useNavigate();

  useEffect(() => {
    setP(null);
    setError("");
    call(api.getPlaylist, { params: { id } })
      .then(setP)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [id]);

  if (error) return <div className="page muted">{error}</div>;
  if (!p) return <div className="page" />;

  const changed = (next: PlaylistData) => {
    setP(next);
    void loadPlaylists();
  };
  const edit = (f: () => Promise<PlaylistData>) =>
    f()
      .then(changed)
      .catch((e: unknown) => notify(errorMessage(e)));

  const rows: Row[] = p.entries.map((e) => ({
    track: e.track,
    title: e.snapshot.title,
    artistName: e.snapshot.artistName,
    albumTitle: e.snapshot.albumTitle,
    durationMs: e.snapshot.durationMs,
    key: e.entryId,
  }));
  // The server skips missing entries, so count only playable ones before the row.
  const playFrom = (i: number) =>
    void play(shown(p), p.entries.slice(0, i).filter((e) => e.track).length, false);
  const tracks =
    p.matching !== null && p.matching > p.trackCount
      ? `Smart · ${plural(p.trackCount, "track")} of ${p.matching} matching`
      : `${p.rules ? "Smart · " : ""}${plural(p.trackCount, "track")}`;

  return (
    <div className="page">
      <header className="hero">
        <Mosaic covers={p.covers} size={200} />
        <div className="hero-text">
          <div className="caps">{p.rules ? "Smart playlist" : "Playlist"}</div>
          {renaming === null ? (
            <h1>{p.name}</h1>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = renaming.trim();
                setRenaming(null);
                if (name && name !== p.name)
                  void edit(() => call(api.updatePlaylist, { params: { id }, body: { name } }));
              }}
            >
              <input
                autoFocus
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              />
            </form>
          )}
          {p.description && <div className="muted">{p.description}</div>}
          <div className="muted">
            {tracks} · {duration(p.durationMs)}
          </div>
          <div className="hero-actions">
            <button className="primary-button" disabled={p.trackCount === 0} onClick={() => playFrom(0)}>
              <Icon name="play" size={16} /> Play
            </button>
            <button
              className="outline-button"
              disabled={p.trackCount === 0}
              onClick={() => void play(shown(p), 0, true, "playlist")}
            >
              Shuffle
            </button>
            <MenuButton
              items={() => [
                ...queueAndPlaylistItems(shown(p), p.name).filter(
                  (item) => item.label !== "Add to playlist" || !p.rules,
                ),
                { label: "Rename", onSelect: () => setRenaming(p.name) },
                {
                  label: "Delete playlist",
                  danger: true,
                  onSelect: () => {
                    if (!window.confirm(`Delete “${p.name}”? This can't be undone.`)) return;
                    call(api.deletePlaylist, { params: { id } })
                      .then(() => {
                        void loadPlaylists();
                        void navigate("/");
                      })
                      .catch((e: unknown) => notify(errorMessage(e)));
                  },
                },
              ]}
            />
          </div>
        </div>
      </header>
      {p.rules && (
        <p className="faint">Its tracks follow its rules; edit them in the desktop player for now.</p>
      )}
      {p.entries.length === 0 && !p.rules && (
        <p className="muted">Empty. Add tracks with the ⋯ menu next to any track or album.</p>
      )}
      <TrackList
        rows={rows}
        onPlay={playFrom}
        extraItems={(i) => {
          if (p.rules) return [];
          const entryId = p.entries[i]!.entryId;
          return [
            ...(i > 0
              ? [
                  {
                    label: "Move up",
                    onSelect: () =>
                      void edit(() =>
                        call(api.movePlaylistEntry, { params: { id, entryId }, body: { toIndex: i - 1 } }),
                      ),
                  },
                ]
              : []),
            ...(i < p.entries.length - 1
              ? [
                  {
                    label: "Move down",
                    onSelect: () =>
                      void edit(() =>
                        call(api.movePlaylistEntry, { params: { id, entryId }, body: { toIndex: i + 1 } }),
                      ),
                  },
                ]
              : []),
            {
              label: "Remove from playlist",
              danger: true,
              onSelect: () => void edit(() => call(api.removeFromPlaylist, { params: { id, entryId } })),
            },
          ];
        }}
      />
    </div>
  );
}

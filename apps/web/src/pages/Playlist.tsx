import type { Playlist as PlaylistData, TrackSource } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, call, errorMessage } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { Mosaic } from "../components/Mosaic.tsx";
import { SmartEditor } from "../components/SmartEditor.tsx";
import { freshName } from "../player/smart.ts";
import { TrackList, type Row } from "../components/TrackList.tsx";
import { queueAndPlaylistItems } from "../components/trackActions.ts";
import { duration } from "../format.ts";
import { useLibrary } from "../stores/library.ts";
import { usePlayer } from "../stores/player.ts";
import "./pages.css";
import { t, tn } from "../i18n.ts";

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
      ? tn("Smart · {n} track of {} matching", "Smart · {n} tracks of {} matching", p.trackCount, p.matching)
      : p.rules
        ? tn("Smart · {n} track", "Smart · {n} tracks", p.trackCount)
        : tn("{n} track", "{n} tracks", p.trackCount);

  return (
    <div className="page">
      <header className="hero">
        <Mosaic covers={p.covers} size={200} />
        <div className="hero-text">
          <div className="caps">{p.rules ? t("Smart playlist") : t("Playlist")}</div>
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
              <Icon name="play" size={16} /> {t("Play")}
            </button>
            <button
              className="outline-button"
              disabled={p.trackCount === 0}
              onClick={() => void play(shown(p), 0, true, "playlist")}
            >
              {t("Shuffle")}
            </button>
            <MenuButton
              items={() => [
                ...queueAndPlaylistItems(shown(p), p.name).filter(
                  (item) => item.label !== t("Add to playlist") || !p.rules,
                ),
                { label: t("Rename"), onSelect: () => setRenaming(p.name) },
                {
                  label: t("Delete playlist"),
                  danger: true,
                  onSelect: () => {
                    if (!window.confirm(t("Delete “{}”? This can't be undone.", p.name))) return;
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
        <SmartEditor
          key={p.id}
          playlist={p}
          onChanged={changed}
          onSaveCopy={() => {
            const name = freshName(
              t("{} (saved)", p.name),
              useLibrary.getState().playlists.map((x) => x.name),
            );
            const trackIds = p.entries.flatMap((e) => (e.track ? [e.track.id] : []));
            void useLibrary
              .getState()
              .createPlaylist(name, trackIds)
              .then((newId) => newId && navigate(`/playlist/${newId}`));
          }}
        />
      )}
      {p.entries.length === 0 && !p.rules && (
        <p className="muted">{t("Empty. Add tracks with the ⋯ menu next to any track or album.")}</p>
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
                    label: t("Move up"),
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
                    label: t("Move down"),
                    onSelect: () =>
                      void edit(() =>
                        call(api.movePlaylistEntry, { params: { id, entryId }, body: { toIndex: i + 1 } }),
                      ),
                  },
                ]
              : []),
            {
              label: t("Remove from playlist"),
              danger: true,
              onSelect: () => void edit(() => call(api.removeFromPlaylist, { params: { id, entryId } })),
            },
          ];
        }}
      />
    </div>
  );
}

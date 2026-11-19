import type { Track, TrackSource } from "@hyperplayer/schemas";
import { useLibrary } from "../stores/library.ts";
import type { MenuItem } from "./Menu.tsx";
import { t } from "../i18n.ts";

/** "Play next", "Add to queue" and "Add to playlist ▸" for a track, album, artist or genre. */
export function queueAndPlaylistItems(source: TrackSource, what: string): MenuItem[] {
  const lib = useLibrary.getState();
  const editable = lib.playlists.filter((p) => !p.rules);
  return [
    { label: t("Play next"), onSelect: () => void lib.addToQueue(source, "next", what) },
    { label: t("Add to queue"), onSelect: () => void lib.addToQueue(source, "end", what) },
    {
      label: t("Add to playlist"),
      items: [
        ...editable.map((p) => ({
          label: p.name,
          onSelect: () => void lib.addToPlaylist(p.id, source, what),
        })),
        {
          label: t("New playlist…"),
          onSelect: () => {
            const name = window.prompt(t("Name of the new playlist"), what);
            if (name?.trim()) {
              void lib.createPlaylist(name.trim()).then(async (id) => {
                if (id) await lib.addToPlaylist(id, source, what);
              });
            }
          },
        },
      ],
    },
  ];
}

export function trackSource(track: Track): TrackSource {
  return { kind: "tracks", trackIds: [track.id] };
}

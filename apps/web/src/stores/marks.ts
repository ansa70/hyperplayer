// The user's marks on tracks (favourite, left out of the whole-library shuffle) as changed
// here: lists loaded earlier still hold the marks tracks had then, so rows look here first.

import type { Track } from "@hyperplayer/schemas";
import { create } from "zustand";
import { api, call, errorMessage } from "../api.ts";
import { useLibrary } from "./library.ts";
import { t } from "../i18n.ts";

export interface Marks {
  favourite: boolean;
  shuffleExcluded: boolean;
  /** 1 to 5 stars; 0 when unrated. */
  rating: number;
}

interface MarksState {
  /** By track id: marks changed since the lists showing them were loaded. */
  changed: Record<string, Marks>;
  /** Bumped on every change, so the lists of marked tracks load again. */
  version: number;
  set: (track: Track, change: Partial<Marks>) => Promise<void>;
  /** Takes in a track's marks as the server now has them. */
  took: (track: Track) => void;
}

const marksOfTrack = (t: Track): Marks => ({
  favourite: t.favourite,
  shuffleExcluded: t.shuffleExcluded,
  rating: t.rating,
});

export const useMarks = create<MarksState>()((set) => ({
  changed: {},
  version: 0,

  async set(track, change) {
    const notify = useLibrary.getState().notify;
    try {
      const updated = await call(api.setTrackMarks, { params: { id: track.id }, body: change });
      set((s) => ({ changed: { ...s.changed, [track.id]: marksOfTrack(updated) }, version: s.version + 1 }));
      if (change.favourite !== undefined)
        notify(
          change.favourite
            ? t("Added “{}” to favourites", track.title)
            : t("Removed “{}” from favourites", track.title),
        );
      else if (change.shuffleExcluded !== undefined)
        notify(
          change.shuffleExcluded
            ? t("“{}” is left out of the library shuffle", track.title)
            : t("“{}” is back in the library shuffle", track.title),
        );
    } catch (e) {
      notify(errorMessage(e));
    }
  },

  took(track) {
    set((s) => ({ changed: { ...s.changed, [track.id]: marksOfTrack(track) }, version: s.version + 1 }));
  },
}));

/** A track's marks as they are now. */
export function useTrackMarks(track: Track | null): Marks {
  const changed = useMarks((s) => (track ? s.changed[track.id] : undefined));
  return (
    changed ?? {
      favourite: track?.favourite ?? false,
      shuffleExcluded: track?.shuffleExcluded ?? false,
      rating: track?.rating ?? 0,
    }
  );
}

/** The same, outside components (menus are built when opened). */
export function marksOf(track: Track): Marks {
  return useMarks.getState().changed[track.id] ?? marksOfTrack(track);
}

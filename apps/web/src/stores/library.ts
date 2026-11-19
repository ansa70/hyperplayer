// The account's playlists, shared by the sidebar, the playlist pages and the track menus.

import type { PlaylistSummary, TrackSource, UploadInfo } from "@hyperplayer/schemas";
import { create } from "zustand";
import { api, call, errorMessage } from "../api.ts";
import { usePlayer } from "./player.ts";
import { t, tn } from "../i18n.ts";

interface LibraryState {
  playlists: PlaylistSummary[];
  /** A short confirmation or error, shown briefly (the Rust player's status line). */
  notice: string;
  /** Bumped when tracks were added or removed (uploads), so lists load again. */
  version: number;
  uploads: UploadInfo | null;
  loadUploads: () => Promise<void>;
  libraryChanged: () => void;
  loadPlaylists: () => Promise<void>;
  createPlaylist: (name: string, trackIds?: string[]) => Promise<string | null>;
  addToPlaylist: (playlistId: string, source: TrackSource, what: string) => Promise<void>;
  addToQueue: (source: TrackSource, placement: "next" | "end", what: string) => Promise<void>;
  notify: (message: string) => void;
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export const useLibrary = create<LibraryState>()((set, get) => ({
  playlists: [],
  notice: "",
  version: 0,
  uploads: null,

  async loadUploads() {
    try {
      set({ uploads: await call(api.uploadInfo) });
    } catch {
      // An older server: no uploads.
      set({ uploads: null });
    }
  },

  libraryChanged() {
    set((s) => ({ version: s.version + 1 }));
    void get().loadUploads();
  },

  async loadPlaylists() {
    try {
      set({ playlists: await call(api.listPlaylists) });
    } catch (e) {
      get().notify(errorMessage(e));
    }
  },

  async createPlaylist(name, trackIds) {
    try {
      const p = await call(api.createPlaylist, { body: { name, trackIds } });
      await get().loadPlaylists();
      return p.id;
    } catch (e) {
      get().notify(errorMessage(e));
      return null;
    }
  },

  async addToPlaylist(playlistId, source, what) {
    try {
      const before = get().playlists.find((p) => p.id === playlistId)?.trackCount ?? 0;
      const p = await call(api.addToPlaylist, { params: { id: playlistId }, body: { source } });
      get().notify(
        tn(
          "Added “{}” to {}: {n} track",
          "Added “{}” to {}: {n} tracks",
          p.trackCount - before,
          what,
          p.name,
        ),
      );
      await get().loadPlaylists();
    } catch (e) {
      get().notify(errorMessage(e));
    }
  },

  async addToQueue(source, placement, what) {
    try {
      const queue = await call(api.addToQueue, { body: { source, placement } });
      usePlayer.setState({ queue });
      get().notify(placement === "next" ? t("“{}” plays next", what) : t("Added “{}” to the queue", what));
    } catch (e) {
      get().notify(errorMessage(e));
    }
  },

  notify(message) {
    set({ notice: message });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => set({ notice: "" }), 4000);
  },
}));

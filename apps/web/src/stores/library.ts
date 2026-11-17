// The account's playlists, shared by the sidebar, the playlist pages and the track menus.

import type { PlaylistSummary, TrackSource } from "@hyperplayer/schemas";
import { create } from "zustand";
import { api, call, errorMessage } from "../api.ts";
import { plural } from "../format.ts";
import { usePlayer } from "./player.ts";

interface LibraryState {
  playlists: PlaylistSummary[];
  /** A short confirmation or error, shown briefly (the Rust player's status line). */
  notice: string;
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
      get().notify(`Added “${what}” to ${p.name}: ${plural(p.trackCount - before, "track")}`);
      await get().loadPlaylists();
    } catch (e) {
      get().notify(errorMessage(e));
    }
  },

  async addToQueue(source, placement, what) {
    try {
      const queue = await call(api.addToQueue, { body: { source, placement } });
      usePlayer.setState({ queue });
      get().notify(placement === "next" ? `“${what}” plays next` : `Added “${what}” to the queue`);
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

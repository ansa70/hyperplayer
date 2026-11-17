import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Shell } from "./layout/Shell.tsx";
import { Album } from "./pages/Album.tsx";
import { Albums } from "./pages/Albums.tsx";
import { Artist } from "./pages/Artist.tsx";
import { Home } from "./pages/Home.tsx";
import { Login } from "./pages/Login.tsx";
import { Playlist } from "./pages/Playlist.tsx";
import { Playlists } from "./pages/Playlists.tsx";
import { Queue } from "./pages/Queue.tsx";
import { Search } from "./pages/Search.tsx";
import { Settings } from "./pages/Settings.tsx";
import { useLibrary } from "./stores/library.ts";
import { usePlayer } from "./stores/player.ts";
import { useSession } from "./stores/session.ts";

export function App() {
  const status = useSession((s) => s.status);
  const restore = useSession((s) => s.restore);
  const preferences = useSession((s) => s.preferences);

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (status === "signed-in") {
      void usePlayer.getState().loadQueue();
      void useLibrary.getState().loadPlaylists();
    } else if (status === "signed-out") usePlayer.getState().stop();
  }, [status]);

  useEffect(() => {
    if (preferences) usePlayer.getState().setPreferences(preferences);
  }, [preferences]);

  if (status === "checking") return null;
  if (status !== "signed-in") return <Login />;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="albums" element={<Albums />} />
          <Route path="artist/:id" element={<Artist />} />
          <Route path="album/:id" element={<Album />} />
          <Route path="queue" element={<Queue />} />
          <Route path="search" element={<Search />} />
          <Route path="playlists" element={<Playlists />} />
          <Route path="playlist/:id" element={<Playlist />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Shell } from "./layout/Shell.tsx";
import { Album } from "./pages/Album.tsx";
import { Albums } from "./pages/Albums.tsx";
import { Artist } from "./pages/Artist.tsx";
import { Home } from "./pages/Home.tsx";
import { Login } from "./pages/Login.tsx";
import { Queue } from "./pages/Queue.tsx";
import { usePlayer } from "./stores/player.ts";
import { useSession } from "./stores/session.ts";

export function App() {
  const status = useSession((s) => s.status);
  const restore = useSession((s) => s.restore);
  const quality = useSession((s) => s.preferences?.quality);

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (status === "signed-in") void usePlayer.getState().loadQueue();
    else if (status === "signed-out") usePlayer.getState().stop();
  }, [status]);

  useEffect(() => {
    if (quality) usePlayer.getState().setMode(quality);
  }, [quality]);

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
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

import { useCallback, useState, useSyncExternalStore } from "react";
import { Outlet } from "react-router";
import { MiniPlayer, NowPlayingSheet, TabBar } from "./Mobile.tsx";
import { NowPlayingPanel } from "./NowPlayingPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TransportBar } from "./TransportBar.tsx";
import "./layout.css";

const PHONE = "(max-width: 760px)";

/** Whether the window is phone-sized (follows resizes and rotation). */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const q = matchMedia(PHONE);
      q.addEventListener("change", changed);
      return () => q.removeEventListener("change", changed);
    },
    () => matchMedia(PHONE).matches,
  );
}

/** The window: three columns and a player bar on desktops, tabs and a mini-player on phones. */
export function Shell() {
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  const closeSheet = useCallback(() => setSheet(false), []);
  if (phone) {
    return (
      <div className="phone">
        <main className="content">
          <Outlet />
        </main>
        <MiniPlayer onOpen={() => setSheet(true)} />
        <TabBar />
        {sheet && <NowPlayingSheet onClose={closeSheet} />}
      </div>
    );
  }
  return (
    <div className="desktop">
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
      <NowPlayingPanel />
      <TransportBar />
    </div>
  );
}

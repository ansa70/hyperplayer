import { useCallback, useState, useSyncExternalStore } from "react";
import { Outlet } from "react-router";
import { FollowPlaying } from "./FollowPlaying.tsx";
import { useLibrary } from "../stores/library.ts";
import { MiniPlayer, NowPlayingSheet, TabBar } from "./Mobile.tsx";
import { NowPlayingPanel } from "./NowPlayingPanel.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TransportBar } from "./TransportBar.tsx";
import { TrimOffer } from "./TrimOffer.tsx";
import { PropertiesDialog } from "../components/PropertiesDialog.tsx";
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
function Notice() {
  const notice = useLibrary((s) => s.notice);
  return notice ? <div className="notice">{notice}</div> : null;
}

export function Shell() {
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  const closeSheet = useCallback(() => setSheet(false), []);
  if (phone) {
    return (
      <div className="phone">
        <FollowPlaying />
        <main className="content">
          <Outlet />
        </main>
        <MiniPlayer onOpen={() => setSheet(true)} />
        <TabBar />
        <Notice />
        <TrimOffer />
        <PropertiesDialog />
        {sheet && <NowPlayingSheet onClose={closeSheet} />}
      </div>
    );
  }
  return (
    <div className="desktop">
      <FollowPlaying />
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
      <NowPlayingPanel />
      <TransportBar />
      <Notice />
      <TrimOffer />
      <PropertiesDialog />
    </div>
  );
}

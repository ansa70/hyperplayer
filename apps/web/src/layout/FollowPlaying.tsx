import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { usePlayer } from "../stores/player.ts";

/**
 * As in the Rust player: when a track starts playing, the panel shows where it plays
 * from (the playlist the queue was started from, otherwise its album), unless it's
 * showing that already, or the lyrics or the queue (they follow the track themselves).
 */
export function FollowPlaying() {
  const navigate = useNavigate();
  const location = useLocation();
  const path = useRef(location.pathname);
  path.current = location.pathname;

  useEffect(() => {
    // The track shown at startup (the saved queue, not playing) isn't followed.
    let followed: string | null = usePlayer.getState().track?.id ?? null;
    return usePlayer.subscribe((s) => {
      const id = s.track?.id ?? null;
      if (!s.playing || !id || id === followed) return;
      followed = id;
      if (path.current === "/lyrics" || path.current === "/queue") return;
      const origin = s.queue?.origin;
      const target =
        origin?.kind === "playlist" && origin.id ? `/playlist/${origin.id}` : `/album/${s.track!.albumId}`;
      if (path.current !== target) void navigate(target);
    });
  }, [navigate]);
  return null;
}

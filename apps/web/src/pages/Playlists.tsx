import { Icon } from "../components/Icon.tsx";
import { PlaylistRow, useNewPlaylist } from "../layout/Sidebar.tsx";
import { useLibrary } from "../stores/library.ts";
import "./pages.css";

/** The playlists, on phones (the sidebar lists them on desktops). */
export function Playlists() {
  const playlists = useLibrary((s) => s.playlists);
  const newPlaylist = useNewPlaylist();
  return (
    <div className="page">
      <div className="page-head">
        <h1>Playlists</h1>
        <button className="plus-button" title="New playlist" onClick={newPlaylist}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      {playlists.length === 0 && <p className="muted">No playlists yet.</p>}
      {playlists.map((p) => (
        <PlaylistRow key={p.id} playlist={p} />
      ))}
    </div>
  );
}

import { NewPlaylistMenu, PlaylistRow } from "../layout/Sidebar.tsx";
import { useLibrary } from "../stores/library.ts";
import "./pages.css";
import { t } from "../i18n.ts";

/** The playlists, on phones (the sidebar lists them on desktops). */
export function Playlists() {
  const playlists = useLibrary((s) => s.playlists);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Playlists")}</h1>
        <NewPlaylistMenu />
      </div>
      {playlists.length === 0 && <p className="muted">{t("No playlists yet.")}</p>}
      {playlists.map((p) => (
        <PlaylistRow key={p.id} playlist={p} />
      ))}
    </div>
  );
}

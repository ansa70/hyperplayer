import { Link } from "react-router";
import { ArtistRow, useArtists } from "../layout/Sidebar.tsx";
import { usePhone } from "../layout/Shell.tsx";
import { useSession } from "../stores/session.ts";
import { Icon } from "../components/Icon.tsx";
import "./pages.css";

/** The desktop's welcome page; on phones, the library (the sidebar's artists). */
export function Home() {
  const phone = usePhone();
  const user = useSession((s) => s.user);
  const artists = useArtists();
  if (!phone) {
    return (
      <div className="page welcome">
        <h1>Welcome{user?.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}</h1>
        <p className="muted">Pick an artist on the left, or browse the albums.</p>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <h1>Library</h1>
        <Link to="/settings" className="icon-button" title="Settings">
          <Icon name="settings" size={20} />
        </Link>
      </div>
      <Link to="/albums" className="nav-row">
        <Icon name="albums" size={18} /> All albums
      </Link>
      <div className="caps section">Artists</div>
      {artists.map((a) => (
        <ArtistRow key={a.id} artist={a} />
      ))}
    </div>
  );
}

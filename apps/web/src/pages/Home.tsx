import { ArtistRow, useArtists } from "../layout/Sidebar.tsx";
import { usePhone } from "../layout/Shell.tsx";
import { useSession } from "../stores/session.ts";
import { Icon } from "../components/Icon.tsx";
import "./pages.css";

/** The desktop's welcome page; on phones, the library (the sidebar's artists). */
export function Home() {
  const phone = usePhone();
  const { user, signOut } = useSession();
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
        <button className="icon-button" title="Sign out" onClick={() => void signOut()}>
          <Icon name="signOut" size={20} />
        </button>
      </div>
      <div className="caps section">Artists</div>
      {artists.map((a) => (
        <ArtistRow key={a.id} artist={a} />
      ))}
    </div>
  );
}

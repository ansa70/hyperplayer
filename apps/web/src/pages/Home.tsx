import { Link } from "react-router";
import { ArtistRow, useArtists } from "../layout/Sidebar.tsx";
import { usePhone } from "../layout/Shell.tsx";
import { useLibrary } from "../stores/library.ts";
import { useSession } from "../stores/session.ts";
import { Icon } from "../components/Icon.tsx";
import "./pages.css";
import { t } from "../i18n.ts";

/** The desktop's welcome page; on phones, the library (the sidebar's artists). */
export function Home() {
  const phone = usePhone();
  const user = useSession((s) => s.user);
  const uploadsOn = useLibrary((s) => s.uploads?.enabled ?? false);
  const artists = useArtists();
  if (!phone) {
    return (
      <div className="page welcome">
        <h1>{user?.fullName ? t("Welcome, {}", user.fullName.split(" ")[0]) : t("Welcome")}</h1>
        <p className="muted">{t("Pick an artist on the left, or browse the albums.")}</p>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Library")}</h1>
        <Link to="/settings" className="icon-button" title={t("Settings")}>
          <Icon name="settings" size={20} />
        </Link>
      </div>
      <Link to="/albums" className="nav-row">
        <Icon name="albums" size={18} /> {t("All albums")}
      </Link>
      <Link to="/favourites" className="nav-row">
        <Icon name="star" size={18} /> {t("Favourites")}
      </Link>
      <Link to="/history" className="nav-row">
        <Icon name="history" size={18} /> {t("History")}
      </Link>
      <Link to="/radio" className="nav-row">
        <Icon name="radio" size={18} /> {t("Radio")}
      </Link>
      {uploadsOn && (
        <Link to="/uploads" className="nav-row">
          <Icon name="upload" size={18} /> {t("Uploads")}
        </Link>
      )}
      <div className="caps section">{t("Artists")}</div>
      {artists.map((a) => (
        <ArtistRow key={a.id} artist={a} />
      ))}
    </div>
  );
}

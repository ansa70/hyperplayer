import type { ArtistSummary } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { api, call } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { plural } from "../format.ts";
import { useSession } from "../stores/session.ts";

/** Loads every artist, a page at a time. */
export function useArtists(): ArtistSummary[] {
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  useEffect(() => {
    let stop = false;
    void (async () => {
      const all: ArtistSummary[] = [];
      for (let offset = 0; !stop; offset += 500) {
        const page = await call(api.listArtists, { query: { offset, limit: 500 } });
        all.push(...page.items);
        setArtists([...all]);
        if (all.length >= page.total || page.items.length === 0) break;
      }
    })().catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  return artists;
}

export function ArtistRow({ artist }: { artist: ArtistSummary }) {
  return (
    <NavLink to={`/artist/${artist.id}`} className="artist-row">
      <Cover art={artist.image} size={36} round />
      <span className="artist-row-text">
        <span className="ellipsis">{artist.name}</span>
        <span className="faint ellipsis">{plural(artist.albumCount, "album")}</span>
      </span>
    </NavLink>
  );
}

/** The desktop sidebar: navigation, the artists, and the account. */
export function Sidebar() {
  const artists = useArtists();
  const { user, signOut } = useSession();
  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <div className="brand">HyperPlayer</div>
        <NavLink to="/albums" className="nav-row">
          <Icon name="albums" size={18} /> Albums
        </NavLink>
        <NavLink to="/queue" className="nav-row">
          <Icon name="queue" size={18} /> Queue
        </NavLink>
        <div className="caps sidebar-heading">Artists</div>
      </div>
      <div className="sidebar-artists">
        {artists.map((a) => (
          <ArtistRow key={a.id} artist={a} />
        ))}
      </div>
      <div className="sidebar-account">
        <Icon name="user" size={18} className="muted" />
        <span className="ellipsis">{user?.fullName || user?.username}</span>
        <button className="icon-button" title="Sign out" onClick={() => void signOut()}>
          <Icon name="signOut" size={16} />
        </button>
      </div>
    </nav>
  );
}

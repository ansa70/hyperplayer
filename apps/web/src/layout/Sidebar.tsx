import type { ArtistSummary, PlaylistSummary } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api, call } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { plural } from "../format.ts";
import { Mosaic } from "../components/Mosaic.tsx";
import { useLibrary } from "../stores/library.ts";
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

export function PlaylistRow({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <NavLink to={`/playlist/${playlist.id}`} className="artist-row">
      <Mosaic covers={playlist.covers} size={36} />
      <span className="artist-row-text">
        <span className="ellipsis">{playlist.name}</span>
        <span className="faint ellipsis">
          {playlist.rules ? "Smart · " : ""}
          {plural(playlist.trackCount, "track")}
        </span>
      </span>
    </NavLink>
  );
}

/** Asks for a name and makes an empty playlist, then opens it. */
export function useNewPlaylist() {
  const create = useLibrary((s) => s.createPlaylist);
  const navigate = useNavigate();
  return () => {
    const name = window.prompt("Name of the new playlist");
    if (name?.trim()) void create(name.trim()).then((id) => id && navigate(`/playlist/${id}`));
  };
}

/** The desktop sidebar: search, navigation, playlists, the artists, and the account. */
export function Sidebar() {
  const artists = useArtists();
  const playlists = useLibrary((s) => s.playlists);
  const newPlaylist = useNewPlaylist();
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  // The box keeps what's typed (the URL follows it): taking it back from the URL, which
  // updates a moment later, would drop keystrokes typed meanwhile.
  const [q, setQ] = useState("");
  const onSearch = location.pathname === "/search";
  useEffect(() => {
    if (!onSearch) setQ("");
  }, [onSearch]);
  return (
    <nav className="sidebar">
      <div className="sidebar-top">
        <div className="brand">HyperPlayer</div>
        <input
          type="search"
          placeholder="Search artists, albums, tracks"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            void navigate(e.target.value ? `/search?q=${encodeURIComponent(e.target.value)}` : "/", {
              replace: onSearch,
            });
          }}
        />
        <NavLink to="/albums" className="nav-row">
          <Icon name="albums" size={18} /> Albums
        </NavLink>
        <NavLink to="/history" className="nav-row">
          <Icon name="history" size={18} /> History
        </NavLink>
      </div>
      <div className="sidebar-artists">
        <div className="sidebar-heading-row">
          <span className="caps">Playlists</span>
          <button className="plus-button" title="New playlist" onClick={newPlaylist}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        {playlists.map((p) => (
          <PlaylistRow key={p.id} playlist={p} />
        ))}
        <div className="caps sidebar-heading">Artists</div>
        {artists.map((a) => (
          <ArtistRow key={a.id} artist={a} />
        ))}
      </div>
      <div className="sidebar-account">
        <Icon name="user" size={18} className="muted" />
        <span className="ellipsis">{user?.fullName || user?.username}</span>
        <NavLink to="/settings" className="icon-button" title="Settings">
          <Icon name="settings" size={16} />
        </NavLink>
        <button className="icon-button" title="Sign out" onClick={() => void signOut()}>
          <Icon name="signOut" size={16} />
        </button>
      </div>
    </nav>
  );
}

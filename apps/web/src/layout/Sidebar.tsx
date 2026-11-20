import type { ArtistSummary, PlaylistSummary } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api, call, errorMessage } from "../api.ts";
import { Cover } from "../components/Cover.tsx";
import { Icon } from "../components/Icon.tsx";
import { MenuButton } from "../components/Menu.tsx";
import { Mosaic } from "../components/Mosaic.tsx";
import { freshName, TEMPLATES } from "../player/smart.ts";
import { useLibrary } from "../stores/library.ts";
import { useSession } from "../stores/session.ts";
import { t, tn } from "../i18n.ts";

/** Loads every artist, a page at a time. */
export function useArtists(): ArtistSummary[] {
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  // Loaded again when uploads add or remove artists.
  const version = useLibrary((s) => s.version);
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
  }, [version]);
  return artists;
}

export function ArtistRow({ artist }: { artist: ArtistSummary }) {
  return (
    <NavLink to={`/artist/${artist.id}`} className="artist-row">
      <Cover art={artist.image} size={36} round />
      <span className="artist-row-text">
        <span className="ellipsis">{artist.name}</span>
        <span className="faint ellipsis">{tn("{n} album", "{n} albums", artist.albumCount)}</span>
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
          {playlist.rules
            ? tn("Smart · {n} track", "Smart · {n} tracks", playlist.trackCount)
            : tn("{n} track", "{n} tracks", playlist.trackCount)}
        </span>
      </span>
    </NavLink>
  );
}

/** The "+" menu: an empty playlist (asking its name), or a smart one from a template. */
export function NewPlaylistMenu() {
  const { createPlaylist, playlists, notify } = useLibrary();
  const navigate = useNavigate();
  const open = (id: string | null) => {
    if (id) void navigate(`/playlist/${id}`);
  };
  return (
    <MenuButton
      title={t("New playlist")}
      items={() => [
        {
          label: t("Empty playlist"),
          onSelect: () => {
            const name = window.prompt(t("Name of the new playlist"));
            if (name?.trim()) void createPlaylist(name.trim()).then(open);
          },
        },
        ...TEMPLATES.map((template) => ({
          label: t("Smart: {}", t(template.label).toLowerCase()),
          onSelect: () => {
            const name = freshName(
              t(template.name),
              playlists.map((p) => p.name),
            );
            call(api.createPlaylist, { body: { name, rules: template.rules } })
              .then((p) => {
                void useLibrary.getState().loadPlaylists();
                open(p.id);
              })
              .catch((e: unknown) => notify(errorMessage(e)));
          },
        })),
      ]}
    >
      <span className="plus-button">
        <Icon name="plus" size={16} />
      </span>
    </MenuButton>
  );
}

/** The desktop sidebar: search, navigation, playlists, the artists, and the account. */
export function Sidebar() {
  const artists = useArtists();
  const playlists = useLibrary((s) => s.playlists);
  const uploadsOn = useLibrary((s) => s.uploads?.enabled ?? false);
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
          placeholder={t("Search artists, albums, tracks")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            void navigate(e.target.value ? `/search?q=${encodeURIComponent(e.target.value)}` : "/", {
              replace: onSearch,
            });
          }}
        />
        <NavLink to="/albums" className="nav-row">
          <Icon name="albums" size={18} /> {t("Albums")}
        </NavLink>
        <NavLink to="/history" className="nav-row">
          <Icon name="history" size={18} /> {t("History")}
        </NavLink>
        <NavLink to="/radio" className="nav-row">
          <Icon name="radio" size={18} /> {t("Radio")}
        </NavLink>
        {uploadsOn && (
          <NavLink to="/uploads" className="nav-row">
            <Icon name="upload" size={18} /> {t("Uploads")}
          </NavLink>
        )}
      </div>
      <div className="sidebar-artists">
        <div className="sidebar-heading-row">
          <span className="caps">{t("Playlists")}</span>
          <NewPlaylistMenu />
        </div>
        {playlists.map((p) => (
          <PlaylistRow key={p.id} playlist={p} />
        ))}
        <div className="caps sidebar-heading">{t("Artists")}</div>
        {artists.map((a) => (
          <ArtistRow key={a.id} artist={a} />
        ))}
      </div>
      <div className="sidebar-account">
        <Icon name="user" size={18} className="muted" />
        <span className="ellipsis">{user?.fullName || user?.username}</span>
        <NavLink to="/settings" className="icon-button" title={t("Settings")}>
          <Icon name="settings" size={16} />
        </NavLink>
        <button className="icon-button" title={t("Sign out")} onClick={() => void signOut()}>
          <Icon name="signOut" size={16} />
        </button>
      </div>
    </nav>
  );
}

import type { RadioFacet, RadioStation } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import { api, call, errorMessage, HttpError } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { Segmented } from "../components/Segmented.tsx";
import { locale, t } from "../i18n.ts";
import { logoUrl, useRadio } from "../stores/radio.ts";
import "./pages.css";
import "./radio.css";

const PAGE = 50;
const TAGS = 60;
/** Typing in the search box searches once it stops for this long. */
const SEARCH_DELAY = 350;

/** The filters, kept while the player is open (coming back to the page finds them as left). */
const filters = {
  q: "",
  country: null as string | null,
  tag: "",
  order: "popular" as "popular" | "trending",
};

/** A country's name in the player's language, from its code; the directory's (English) one otherwise. */
export function countryName(code: string | null | undefined, fallback?: string | null): string {
  if (!code) return fallback ?? "";
  try {
    return new Intl.DisplayNames([locale()], { type: "region" }).of(code) ?? fallback ?? code;
  } catch {
    return fallback ?? code;
  }
}

/** What's known of a station, in a line; `country`: unless the list is of one country. */
export function stationDetail(s: RadioStation, country = true): string {
  const format =
    s.codec && s.bitrate ? `${s.codec} ${s.bitrate}k` : (s.codec ?? (s.bitrate ? `${s.bitrate}k` : ""));
  return [
    s.custom ? t("Added by you") : "",
    country ? countryName(s.countryCode, s.country) : "",
    s.tags.slice(0, 3).join(", "),
    format,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A station's logo, or the radio icon while it has none (or it doesn't load). */
export function StationLogo({
  station,
  size,
  className,
}: {
  station: RadioStation;
  size: number;
  /** Sizes it instead (the Now Playing panel's and the phone player's cover classes). */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [station.id]);
  return (
    <div className={`station-logo ${className ?? ""}`} style={{ width: size, height: size }}>
      {station.hasLogo && !failed ? (
        <img
          src={logoUrl(station, size)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name="radio" size={Math.round(size / 2)} className="faint" />
      )}
    </div>
  );
}

export function FavouriteStar({ station }: { station: RadioStation }) {
  const setFavourite = useRadio((s) => s.setFavourite);
  const on = useRadio((s) => s.favourites.some((f) => f.id === station.id));
  return (
    <button
      className={`icon-button star ${on ? "on" : ""}`}
      title={on ? t("Remove from favourites") : t("Add to favourites")}
      onClick={(e) => {
        e.stopPropagation();
        void setFavourite(station, !on);
      }}
    >
      <Icon name="star" size={18} />
    </button>
  );
}

function StationRow({ station, country }: { station: RadioStation; country?: boolean }) {
  const play = useRadio((s) => s.play);
  const playing = useRadio((s) => s.live?.id === station.id);
  return (
    <div
      className={`station-row ${playing ? "playing" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => play(station)}
      onKeyDown={(e) => e.key === "Enter" && play(station)}
    >
      <StationLogo station={station} size={40} />
      <div className="station-text">
        <span className="ellipsis station-name">{station.name}</span>
        <span className="ellipsis muted">{stationDetail(station, country)}</span>
      </div>
      {playing && <span className="station-playing">♪</span>}
      <FavouriteStar station={station} />
    </div>
  );
}

function AddStation({ onDone }: { onDone: (message: string) => void }) {
  const loadFavourites = useRadio((s) => s.loadFavourites);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !/^https?:\/\//.test(address.trim())) {
      setError(t("Give the station a name and an address starting with http:// or https://."));
      return;
    }
    call(api.addRadioStation, { body: { name: name.trim(), streamUrl: address.trim() } })
      .then((s) => {
        void loadFavourites();
        onDone(t("{} was added to your favourites.", s.name));
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };
  return (
    <form className="add-station" onSubmit={submit}>
      <p className="muted">
        {t(
          "A station that isn't in the directory: its stream's address (or a .pls / .m3u playlist of it). Only you will see it.",
        )}
      </p>
      <div className="add-station-fields">
        <input placeholder={t("Name")} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          type="url"
          placeholder="https://…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button className="outline-button" type="submit">
          {t("Add")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** The radio: favourites, then the directory's stations by name, country, genre and popularity. */
export function Radio() {
  const favourites = useRadio((s) => s.favourites);
  const loadFavourites = useRadio((s) => s.loadFavourites);
  const [countries, setCountries] = useState<RadioFacet[]>([]);
  const [tags, setTags] = useState<RadioFacet[]>([]);
  const [q, setQ] = useState(filters.q);
  const [query, setQuery] = useState(filters.q);
  const [country, setCountry] = useState(filters.country ?? "");
  const [tag, setTag] = useState(filters.tag);
  const [order, setOrder] = useState(filters.order);
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState(false);
  // The first search waits for the first choice of country, so it isn't the whole world's.
  const [ready, setReady] = useState(filters.country !== null);

  const fail = (e: unknown) => {
    setLoading(false);
    setMessage(
      e instanceof HttpError && e.code === "radio_directory_unavailable"
        ? t("The radio directory can't be reached right now. Your favourites still play.")
        : errorMessage(e),
    );
  };

  useEffect(() => {
    void loadFavourites();
    Promise.all([call(api.radioCountries), call(api.radioTags, { query: { limit: TAGS } })])
      .then(([c, g]) => {
        setCountries(c.items);
        setTags(g.items);
        // The first time: the browser's country, when the directory has it.
        if (filters.country === null) {
          const code = new Intl.Locale(navigator.language).maximize().region ?? "";
          setCountry(c.items.some((f) => f.value === code) ? code : "");
        }
      })
      .catch(fail)
      .finally(() => setReady(true));
  }, [loadFavourites]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(q), SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [q]);

  if (ready) Object.assign(filters, { q: query, country, tag, order });

  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    setLoading(true);
    setMessage("");
    call(api.searchRadio, {
      query: {
        q: query || undefined,
        country: country || undefined,
        tag: tag || undefined,
        order,
        limit: PAGE,
      },
      signal: abort.signal,
    })
      .then((page) => {
        setStations(page.items);
        setMore(page.more);
        setLoading(false);
        if (page.items.length === 0) setMessage(t("No stations match."));
      })
      .catch((e: unknown) => abort.signal.aborted || fail(e));
    return () => abort.abort();
  }, [ready, query, country, tag, order]);

  const loadMore = () => {
    setLoading(true);
    call(api.searchRadio, {
      query: {
        q: query || undefined,
        country: country || undefined,
        tag: tag || undefined,
        order,
        offset: stations.length,
        limit: PAGE,
      },
    })
      .then((page) => {
        const known = new Set(stations.map((s) => s.id));
        setStations([...stations, ...page.items.filter((s) => !known.has(s.id))]);
        setMore(page.more);
        setLoading(false);
      })
      .catch(fail);
  };

  return (
    <div className="page radio-page">
      <div className="page-head">
        <h1>{t("Radio")}</h1>
        <button className="outline-button" onClick={() => setAdding(!adding)}>
          {adding ? t("Cancel") : t("Add a station…")}
        </button>
      </div>
      {adding && (
        <AddStation
          onDone={(m) => {
            setAdding(false);
            setMessage(m);
          }}
        />
      )}
      {favourites.length > 0 && (
        <>
          <h2 className="radio-heading">{t("Favourites")}</h2>
          <div className="stations">
            {favourites.map((s) => (
              <StationRow key={s.id} station={s} />
            ))}
          </div>
        </>
      )}
      <h2 className="radio-heading">{t("Stations")}</h2>
      <input
        type="search"
        className="search-input"
        placeholder={t("Search stations by name")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="radio-filters">
        <select value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">{t("All countries")}</option>
          {countries.map((c) => (
            <option key={c.value} value={c.value}>
              {countryName(c.value, c.label)}
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">{t("All genres")}</option>
          {tags.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
        <Segmented
          value={order}
          options={[
            { key: "popular", label: t("Popular") },
            { key: "trending", label: t("Trending") },
          ]}
          onPick={(k) => setOrder(k as "popular" | "trending")}
        />
      </div>
      {message && <p className="muted">{message}</p>}
      <div className="stations">
        {stations.map((s) => (
          <StationRow key={s.id} station={s} country={!country} />
        ))}
      </div>
      {loading && <p className="faint">{t("Loading…")}</p>}
      {more && !loading && (
        <div className="radio-more">
          <button className="outline-button" onClick={loadMore}>
            {t("More stations")}
          </button>
        </div>
      )}
      <p className="faint radio-credit">
        {t("Stations come from radio-browser.info, a free directory anyone can add to.")}
      </p>
    </div>
  );
}

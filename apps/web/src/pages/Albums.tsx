import type { AlbumSummary } from "@hyperplayer/schemas";
import { useEffect, useRef, useState } from "react";
import { api, call } from "../api.ts";
import { AlbumGrid } from "../components/AlbumGrid.tsx";
import { Segmented } from "../components/Segmented.tsx";
import "./pages.css";
import { msg, t } from "../i18n.ts";

type Sort = "artist" | "title" | "year" | "added";
const SORTS: { key: Sort; label: string }[] = [
  { key: "artist", label: msg("Artist") },
  { key: "title", label: msg("Title") },
  { key: "year", label: msg("Year") },
  { key: "added", label: msg("Recently added") },
];
const PAGE = 120;

/** Every album, loaded a page at a time as the list scrolls. */
export function Albums() {
  const [sort, setSort] = useState<Sort>("artist");
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const loading = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAlbums([]);
    setTotal(null);
  }, [sort]);

  useEffect(() => {
    const sentinel = end.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting || loading.current) return;
      if (total !== null && albums.length >= total) return;
      loading.current = true;
      call(api.listAlbums, { query: { sort, offset: albums.length, limit: PAGE } })
        .then((page) => {
          setAlbums((a) => [...a, ...page.items]);
          setTotal(page.total);
        })
        .catch(() => {})
        .finally(() => (loading.current = false));
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sort, albums.length, total]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("Albums")}</h1>
        <Segmented
          value={sort}
          options={SORTS.map((s) => ({ ...s, label: t(s.label) }))}
          onPick={(k) => setSort(k as Sort)}
        />
      </div>
      <AlbumGrid albums={albums} />
      <div ref={end} className="sentinel" />
    </div>
  );
}

import type { AlbumSummary } from "@hyperplayer/schemas";
import { useEffect, useRef, useState } from "react";
import { api, call } from "../api.ts";
import { AlbumGrid } from "../components/AlbumGrid.tsx";
import "./pages.css";

type Sort = "artist" | "title" | "year" | "added";
const SORTS: { key: Sort; label: string }[] = [
  { key: "artist", label: "Artist" },
  { key: "title", label: "Title" },
  { key: "year", label: "Year" },
  { key: "added", label: "Recently added" },
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
        <h1>Albums</h1>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="select">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <AlbumGrid albums={albums} />
      <div ref={end} className="sentinel" />
    </div>
  );
}

import { useNavigate } from "react-router";

/** Back to the page before, or the start page when this one was opened directly. */
export function useBack(): () => void {
  const navigate = useNavigate();
  return () => {
    // React Router numbers its history entries: 0 is the first page of this visit.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    void (idx > 0 ? navigate(-1) : navigate("/"));
  };
}

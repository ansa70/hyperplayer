import type { JsonEndpoint } from "@hyperplayer/schemas";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { call, errorMessage, type CallInput } from "./api.ts";

export interface Loaded<T> {
  data: T | undefined;
  error: string;
  loading: boolean;
}

/** Loads an endpoint's response for the component, again whenever `input` or `reload` changes. */
export function useApi<E extends JsonEndpoint>(
  endpoint: E,
  input: Omit<CallInput<E>, "signal"> = {},
  reload: number = 0,
): Loaded<z.output<E["response"]>> {
  const key = JSON.stringify(input);
  const [state, setState] = useState<Loaded<z.output<E["response"]>>>({
    data: undefined,
    error: "",
    loading: true,
  });
  useEffect(() => {
    const abort = new AbortController();
    setState((s) => ({ ...s, loading: true, error: "" }));
    call(endpoint, { ...(JSON.parse(key) as CallInput<E>), signal: abort.signal })
      .then((data) => setState({ data, error: "", loading: false }))
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setState({ data: undefined, error: errorMessage(e), loading: false });
      });
    return () => abort.abort();
  }, [endpoint, key, reload]);
  return state;
}

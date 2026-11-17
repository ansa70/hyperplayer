import type { ScrobbleAccount, ScrobbleSettings } from "@hyperplayer/schemas";
import { useEffect, useRef, useState } from "react";
import { api, call, errorMessage, HttpError } from "../../api.ts";
import { Card } from "./Card.tsx";

/** How often, and how long, to check whether Last.fm access was allowed. */
const LASTFM_POLL = 3000;
const LASTFM_WAIT = 15 * 60_000;

function status(a: ScrobbleAccount): string {
  const parts = [`Connected as ${a.username ?? "?"}`];
  if (a.pending > 0) parts.push(`${a.pending} waiting to be sent`);
  if (a.lastSubmittedAt) parts.push(`last sent ${new Date(a.lastSubmittedAt).toLocaleString()}`);
  return parts.join(" · ");
}

/** Where listens are sent: ListenBrainz (with a token) and Last.fm (allowed on its site). */
export function Scrobbling() {
  const [settings, setSettings] = useState<ScrobbleSettings | null>(null);
  const [token, setToken] = useState("");
  const [lbError, setLbError] = useState("");
  const [fmError, setFmError] = useState("");
  const [fmWaiting, setFmWaiting] = useState<string | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    call(api.getScrobbling)
      .then(setSettings)
      .catch(() => {});
    return () => {
      attempt.current++;
    };
  }, []);

  const connectLb = () => {
    setLbError("");
    call(api.connectListenBrainz, { body: { token: token.trim() } })
      .then((s) => {
        setSettings(s);
        setToken("");
      })
      .catch((e: unknown) => setLbError(errorMessage(e)));
  };

  const connectFm = async () => {
    setFmError("");
    const mine = ++attempt.current;
    // Opened now, while it's a click: a window opened after the request would be blocked.
    const tab = window.open("", "_blank");
    let auth;
    try {
      auth = await call(api.authorizeLastfm);
    } catch (e) {
      tab?.close();
      setFmError(errorMessage(e));
      return;
    }
    if (tab) tab.location.href = auth.url;
    setFmWaiting(auth.url);
    const started = Date.now();
    while (attempt.current === mine && Date.now() - started < LASTFM_WAIT) {
      await new Promise((r) => setTimeout(r, LASTFM_POLL));
      if (attempt.current !== mine) return;
      try {
        setSettings(await call(api.connectLastfm, { body: { token: auth.token } }));
        setFmWaiting(null);
        return;
      } catch (e) {
        // Not allowed yet, or a network hiccup: ask again.
        if (e instanceof HttpError && e.code !== "not_authorized") {
          setFmWaiting(null);
          setFmError(e.message);
          return;
        }
      }
    }
    if (attempt.current === mine) {
      setFmWaiting(null);
      setFmError("Last.fm access wasn't allowed in time. Try again.");
    }
  };

  if (!settings) return <p className="muted">Loading…</p>;
  const { listenbrainz: lb, lastfm: fm } = settings;
  return (
    <>
      <Card title="ListenBrainz">
        {lb.connected ? (
          <>
            <p className="note">{status(lb)}</p>
            {lb.lastError && <p className="note error">{lb.lastError}</p>}
            <div className="row">
              <button
                className="outline-button"
                onClick={() => void call(api.disconnectListenBrainz).then(setSettings)}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="note">
              Sends what you listen to to ListenBrainz. Paste your user token from{" "}
              <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer">
                listenbrainz.org/settings
              </a>
              .
            </p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                connectLb();
              }}
            >
              <input
                value={token}
                placeholder="User token"
                autoComplete="off"
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="outline-button" type="submit" disabled={!token.trim()}>
                Connect
              </button>
            </form>
            {lbError && <p className="note error">{lbError}</p>}
          </>
        )}
      </Card>
      <Card title="Last.fm">
        {!fm.available ? (
          <p className="note">This server isn't set up for Last.fm (it needs a Last.fm API account).</p>
        ) : fm.connected ? (
          <>
            <p className="note">{status(fm)}</p>
            {fm.lastError && <p className="note error">{fm.lastError}</p>}
            <div className="row">
              <button
                className="outline-button"
                onClick={() => void call(api.disconnectLastfm).then(setSettings)}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : fmWaiting ? (
          <>
            <p className="note">
              Allow HyperPlayer on the Last.fm page that opened, then come back here.{" "}
              <a href={fmWaiting} target="_blank" rel="noreferrer">
                Open it again
              </a>
            </p>
            <div className="row">
              <button
                className="outline-button"
                onClick={() => {
                  attempt.current++;
                  setFmWaiting(null);
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="note">Sends what you listen to to your Last.fm account.</p>
            <div className="row">
              <button className="outline-button" onClick={() => void connectFm()}>
                Connect to Last.fm
              </button>
            </div>
            {fmError && <p className="note error">{fmError}</p>}
          </>
        )}
      </Card>
    </>
  );
}

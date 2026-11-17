// Listening history, as the Rust player keeps it: how much of a track is really played,
// "now playing" for scrobbling services, and a listen once enough was heard.

import { api, call } from "../api.ts";

/** Tracks shorter than this never count; playing `ENOUGH` always does (the server checks too). */
const MIN_TRACK = 30;
const ENOUGH = 4 * 60;
/** Position jumps bigger than this between updates are seeks, not playing. */
const MAX_STEP = 2;
const RETRY_AFTER = 30_000;
/** Resuming within this long of the last "now playing" doesn't announce it again. */
const ANNOUNCE_GAP = 30_000;

interface Listening {
  trackId: string;
  length: number;
  startedAt: string;
  played: number;
  lastPosition: number | null;
  reported: boolean;
  announced: boolean;
  lastAnnounced: number;
  nextAttempt: number;
}

let current: Listening | null = null;

/** A new play of a track begins (a track change, not a seek). */
export function begin(trackId: string, lengthMs: number) {
  current = {
    trackId,
    length: lengthMs / 1000,
    startedAt: new Date().toISOString(),
    played: 0,
    lastPosition: null,
    reported: false,
    announced: false,
    lastAnnounced: 0,
    nextAttempt: 0,
  };
}

/** Follows playback of `trackId` at `position` seconds. */
export function follow(trackId: string, position: number, playing: boolean) {
  const l = current;
  if (!l || l.trackId !== trackId) return;
  let advanced = false;
  if (
    playing &&
    l.lastPosition !== null &&
    position > l.lastPosition &&
    position - l.lastPosition < MAX_STEP
  ) {
    l.played += position - l.lastPosition;
    advanced = true;
  }
  l.lastPosition = position;

  const now = Date.now();
  if (!playing) {
    l.announced = false;
  } else if (advanced && !l.announced && now - l.lastAnnounced >= ANNOUNCE_GAP) {
    l.announced = true;
    l.lastAnnounced = now;
    call(api.playingNow, { body: { trackId } }).catch(() => {});
  }

  const counts = l.length >= MIN_TRACK && l.played >= Math.min(l.length / 2, ENOUGH);
  if (!counts || l.reported || now < l.nextAttempt) return;
  l.nextAttempt = now + RETRY_AFTER;
  const { startedAt, played } = l;
  call(api.recordListen, { body: { trackId, startedAt, playedMs: Math.round(played * 1000) } })
    .then(() => {
      if (current?.trackId === trackId && current.startedAt === startedAt) current.reported = true;
    })
    .catch(() => {});
}

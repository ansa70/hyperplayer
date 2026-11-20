// The audio element a radio station plays in, apart from the two the queue's tracks take
// turns in. It's here, not in stores/radio.ts, so the player can unlock it with the others
// and hand the media keys to the station without the two stores importing each other.

export const radioElement: HTMLAudioElement | null = typeof Audio === "undefined" ? null : new Audio();

/** Set by the radio store: whether a station is the current thing, and its play/pause. */
export const radioHooks = {
  live: () => false,
  toggle: () => {},
};

// The web player in other languages. Text is written in English and passed through t()
// (or tn() for a count); each language's translations are in locales/<code>.ts, keyed by
// that English text. Text kept in a constant is marked with msg() and translated where
// it's shown. tests/i18n.test.ts checks every message has its translations.
//
// Placeholders are the desktop player's: {} takes the next argument, {0}, {1}… a given one
// (so a translation can reorder them), {n} the count of a plural.

import { create } from "zustand";
import { it } from "./locales/it.ts";

/** A translation: one text, or the forms for one and for any other count. */
export type Translation = string | readonly [one: string, other: string];

const CATALOGS: Record<string, Record<string, Translation>> = { it };

/** The languages the player speaks, each by its own name, English first. */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "it", name: "Italiano" },
] as const;

const KEY = "hp-language";

/** The language a setting stands for: itself, or ("" for automatic) the browser's when
 *  the player has it, otherwise English. */
export function resolve(
  setting: string,
  preferred: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): string {
  const have = (code: string) => {
    const base = code.toLowerCase().split(/[-_]/)[0];
    return LANGUAGES.find((l) => l.code === base)?.code;
  };
  return (setting && have(setting)) || preferred.map(have).find((c) => c !== undefined) || "en";
}

let current = "en";

function apply(language: string) {
  current = language;
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

function saved(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

interface LanguageState {
  /** "" follows the browser's language; otherwise a code from LANGUAGES. */
  setting: string;
  /** The language in use. */
  language: string;
  setSetting: (setting: string) => void;
}

/** The language in use. Rendering from the top (App) when it changes re-translates all. */
export const useLanguage = create<LanguageState>()((set) => {
  const setting = saved();
  apply(resolve(setting));
  if (typeof window !== "undefined") {
    window.addEventListener("languagechange", () => {
      const { setting } = useLanguage.getState();
      apply(resolve(setting));
      set({ language: current });
    });
  }
  return {
    setting,
    language: current,
    setSetting: (setting) => {
      try {
        if (setting) localStorage.setItem(KEY, setting);
        else localStorage.removeItem(KEY);
      } catch {
        // No storage (a private window): for this visit only.
      }
      apply(resolve(setting));
      set({ setting, language: current });
    },
  };
});

/** The language in use, for dates and numbers (toLocaleDateString and the like). */
export function locale(): string {
  return current;
}

/** What a placeholder takes. */
type Arg = string | number;

function lookup(text: string): Translation | undefined {
  return current === "en" ? undefined : CATALOGS[current]?.[text];
}

/** Fills a template's placeholders. */
export function format(template: string, args: readonly Arg[], n?: number): string {
  let next = 0;
  return template.replace(/\{(\d*|n)\}/g, (whole, key: string) => {
    if (key === "n" && n !== undefined) return String(n);
    const value = key === "" ? args[next++] : args[Number(key)];
    return value === undefined ? whole : String(value);
  });
}

/** `text` in the language in use, its placeholders filled with `args`. */
export function t(text: string, ...args: Arg[]): string {
  const found = lookup(text);
  return format(typeof found === "string" ? found : text, args);
}

/** The form for `n` ("{n} track" / "{n} tracks"), translated, {n} and `args` filled in. */
export function tn(one: string, other: string, n: number, ...args: Arg[]): string {
  const found = lookup(one);
  // Every language so far has English's rule: one form for 1, another otherwise.
  const forms = Array.isArray(found) ? found : [one, other];
  return format(n === 1 ? forms[0]! : forms[1]!, args, n);
}

/** Marks text kept in a constant, to be translated with t() where it's shown. */
export function msg<T extends string>(text: T): T {
  return text;
}

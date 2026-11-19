import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { format, resolve, t, tn, useLanguage } from "../src/i18n.ts";
import { it as italian } from "../src/locales/it.ts";

const SRC = join(import.meta.dirname, "../src");
const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;

/** Every message the source passes to t(), tn() or msg(): its text, and its plural. */
function messages(): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(
    (f) => /\.tsx?$/.test(f) && !f.startsWith("locales") && f !== "i18n.ts",
  );
  for (const file of files) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(new RegExp(String.raw`\b(?:t|msg)\(\s*${STRING}`, "g")))
      found.set(JSON.parse(`"${m[1]}"`), undefined);
    for (const m of text.matchAll(new RegExp(String.raw`\btn\(\s*${STRING}\s*,\s*${STRING}`, "g")))
      found.set(JSON.parse(`"${m[1]}"`), JSON.parse(`"${m[2]}"`));
  }
  return found;
}

const placeholders = (s: string) => (s.match(/\{\d*\}|\{n\}/g) ?? []).sort();

test("every message has its Italian, with the same placeholders", () => {
  const all = messages();
  expect(all.size).toBeGreaterThan(100);
  const missing = [...all.keys()].filter((id) => !(id in italian));
  expect(missing).toEqual([]);
  for (const [id, plural] of all) {
    const translation = italian[id]!;
    expect(Array.isArray(translation), id).toBe(plural !== undefined);
    const forms = typeof translation === "string" ? [translation] : translation;
    const english = plural === undefined ? [id] : [id, plural];
    forms.forEach((form, i) => expect(placeholders(form), id).toEqual(placeholders(english[i]!)));
  }
});

test("no Italian is left over from text the source no longer has", () => {
  const all = messages();
  expect(Object.keys(italian).filter((id) => !all.has(id))).toEqual([]);
});

test("placeholders", () => {
  expect(format("{} of {}", [1, "two"])).toBe("1 of two");
  expect(format("{1} before {0}", ["a", "b"])).toBe("b before a");
  expect(format("{n} tracks, {}", ["x"], 3)).toBe("3 tracks, x");
  expect(format("missing {}", [])).toBe("missing {}");
});

test("languages: a setting, else the browser's, else English", () => {
  expect(resolve("it", ["en-US"])).toBe("it");
  expect(resolve("", ["it-IT", "en"])).toBe("it");
  expect(resolve("", ["de-DE", "fr"])).toBe("en");
  expect(resolve("", ["de-DE", "it"])).toBe("it");
});

test("translates and falls back", () => {
  useLanguage.getState().setSetting("it");
  expect(t("Settings")).toBe("Impostazioni");
  expect(t("not a message anyone wrote")).toBe("not a message anyone wrote");
  expect(tn("{n} track", "{n} tracks", 1)).toBe("1 brano");
  expect(tn("{n} track", "{n} tracks", 4)).toBe("4 brani");
  useLanguage.getState().setSetting("en");
  expect(t("Settings")).toBe("Settings");
  expect(tn("{n} track", "{n} tracks", 4)).toBe("4 tracks");
});

test("credit roles and years", async () => {
  const { role, years } = await import("../src/roles.ts");
  useLanguage.getState().setSetting("it");
  expect(role("tenor saxophone")).toBe("sassofono tenore");
  expect(role("guest tenor saxophone")).toBe("sassofono tenore (ospite)");
  expect(role("co-producer")).toBe("co-produttore");
  expect(role("Piano")).toBe("pianoforte");
  expect(role("nose flute")).toBe("nose flute");
  expect(years("1965–present")).toBe("1965–oggi");
  expect(years("b. 1926")).toBe("n. 1926");
  useLanguage.getState().setSetting("en");
  expect(role("guest tenor saxophone")).toBe("guest tenor saxophone");
});

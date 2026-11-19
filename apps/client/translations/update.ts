// Brings the translation catalogs in line with the source: every @tr(…) in ui/*.slint and
// tr!(…) / trn!(…) in src/ ends up in translations/<lang>/LC_MESSAGES/hyperplayer.po, new
// ones untranslated, ones no longer used dropped. Translations already made are kept.
//
//   vpx apps/client/translations/update.ts            update the catalogs
//   vpx apps/client/translations/update.ts --check    fail if one is out of date or incomplete

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, "..");
const check = process.argv.includes("--check");

type Message = { id: string; plural?: string; refs: Set<string> };

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
}

function extract(): Map<string, Message> {
  const messages = new Map<string, Message>();
  // Files only, without lines, so moving code around doesn't change the catalogs.
  const add = (id: string, file: string, plural?: string) => {
    const ref = relative(client, file);
    const m = messages.get(id) ?? { id, plural, refs: new Set() };
    m.refs.add(ref);
    messages.set(id, m);
  };
  const patterns: [string, RegExp][] = [
    // @tr("text") and @tr("one" | "other" % n), with arguments or not.
    [".slint", new RegExp(String.raw`@tr\(\s*${STRING}(?:\s*\|\s*${STRING})?`, "g")],
    [".rs", new RegExp(String.raw`\b(?:tr|msg)!\(\s*${STRING}`, "g")],
    [".rs", new RegExp(String.raw`\btrn!\(\s*${STRING}\s*,\s*${STRING}`, "g")],
  ];
  for (const [ext, re] of patterns) {
    const dir = join(client, ext === ".slint" ? "ui" : "src");
    // i18n.rs only has the macros' documentation and tests.
    for (const file of files(dir, ext).filter((f) => !f.endsWith("i18n.rs"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(re)) {
        add(unescape(m[1]), file, m[2] === undefined ? undefined : unescape(m[2]));
      }
    }
  }
  return messages;
}

type Entry = { id: string; plural?: string; strs: string[]; fuzzy: boolean };

function parse(po: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const block of po.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const fields: [string, string][] = [];
    let fuzzy = false;
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("#,") && line.includes("fuzzy")) fuzzy = true;
      if (!line || line.startsWith("#")) continue;
      const cont = line.match(new RegExp(`^${STRING}$`));
      if (cont) {
        if (fields.length) fields[fields.length - 1][1] += unescape(cont[1]);
        continue;
      }
      const kv = line.match(new RegExp(String.raw`^(\S+)\s+${STRING}$`));
      if (kv) fields.push([kv[1], unescape(kv[2])]);
    }
    const id = fields.find(([k]) => k === "msgid")?.[1];
    if (id === undefined || id === "") continue;
    entries.set(id, {
      id,
      plural: fields.find(([k]) => k === "msgid_plural")?.[1],
      strs: fields.filter(([k]) => k.startsWith("msgstr")).map(([, v]) => v),
      fuzzy,
    });
  }
  return entries;
}

function header(lang: string, po: string | undefined): string {
  const existing = po?.split(/\n\n/)[0];
  if (existing?.includes('msgid ""')) return existing;
  return [
    `# HyperPlayer, ${lang}. Updated by translations/update.ts; edit the msgstr lines.`,
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    `"Language: ${lang}\\n"`,
    '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
  ].join("\n");
}

function render(lang: string, previous: string | undefined, messages: Map<string, Message>) {
  const old = previous ? parse(previous) : new Map<string, Entry>();
  const blocks = [header(lang, previous)];
  let missing = 0;
  for (const m of [...messages.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const before = old.get(m.id);
    const forms = m.plural ? 2 : 1;
    const strs = Array.from({ length: forms }, (_, i) => before?.strs[i] ?? "");
    if (strs.some((s) => !s) || before?.fuzzy) missing++;
    const lines = [`#: ${[...m.refs].sort().join(" ")}`];
    if (before?.fuzzy) lines.push("#, fuzzy");
    lines.push(`msgid "${escape(m.id)}"`);
    if (m.plural) {
      lines.push(`msgid_plural "${escape(m.plural)}"`);
      strs.forEach((s, i) => lines.push(`msgstr[${i}] "${escape(s)}"`));
    } else {
      lines.push(`msgstr "${escape(strs[0])}"`);
    }
    blocks.push(lines.join("\n"));
  }
  return { text: blocks.join("\n\n") + "\n", missing };
}

const messages = extract();
let failed = false;
for (const lang of readdirSync(here).filter((d) => existsSync(join(here, d, "LC_MESSAGES")))) {
  const path = join(here, lang, "LC_MESSAGES", "hyperplayer.po");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const { text, missing } = render(lang, previous, messages);
  if (check) {
    if (text !== previous) {
      console.error(`${relative(client, path)} is out of date: run translations/update.ts`);
      failed = true;
    }
    if (missing) {
      console.error(`${relative(client, path)}: ${missing} message(s) untranslated`);
      failed = true;
    }
  } else {
    writeFileSync(path, text);
    console.log(`${lang}: ${messages.size} messages, ${missing} untranslated`);
  }
}
if (failed) process.exit(1);

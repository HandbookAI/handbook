#!/usr/bin/env node
/**
 * Structural integrity check for every translated content page.
 *
 * A translation can be fluent and still be broken: a dropped code fence, a
 * `<Callout>` that lost its closing tag, a link whose href got "helpfully"
 * localized, a command translated inside a shell block. None of that is
 * visible in a diff of two languages nobody on the team reads both of, and
 * only some of it fails the MDX build.
 *
 * So this compares each `<name>.<locale>.<ext>` against `<name>.<ext>` on the
 * things that must be IDENTICAL regardless of language:
 *
 *   - the number of fenced code blocks, and their contents byte for byte
 *   - the number of each JSX component used
 *   - every link href
 *   - the frontmatter keys (values are translated; keys are not)
 *
 * Run: node docs/scripts/check-translations.mjs
 * Exit 0 = every translation matches its source structurally.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'docs');
const LOCALES = ['zh', 'hi', 'es', 'pt', 'ru', 'ja', 'de'];

/** Every `.md`/`.mdx` under the content root. */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.mdx?$/.test(entry) ? [full] : [];
  });
}

/** Split `a/b/name.zh.mdx` into its English source path and locale, or null. */
function sourceOf(path) {
  const m = /^(.*)\.([a-z]{2})(\.mdx?)$/.exec(path);
  if (!m || !LOCALES.includes(m[2])) return null;
  return { source: m[1] + m[3], locale: m[2] };
}

/** Fenced code blocks: the fence's info string is metadata, the body is code. */
function fences(text) {
  const out = [];
  const re = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ info: m[3].trim(), body: m[4] });
  return out;
}

/** How many times each JSX component appears (opening tags only). */
function components(text) {
  const counts = {};
  for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

/** Every link target: markdown links, JSX href props, and image srcs. */
function hrefs(text, localise) {
  const found = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)/g)) found.push(m[1]);
  for (const m of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) found.push(m[1]);
  // A translated page is EXPECTED to point at its own locale's diagram, so the
  // English side is normalised the same way before comparing.
  return found.map(localise).sort();
}

function frontmatterKeys(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/^([A-Za-z_][\w-]*):/gm)].map((x) => x[1]).sort();
}

const problems = [];
let checked = 0;

for (const path of walk(root)) {
  const info = sourceOf(path);
  if (!info) continue;
  let source;
  try {
    source = readFileSync(info.source, 'utf8');
  } catch {
    problems.push(`${relative(root, path)}: no English source at ${relative(root, info.source)}`);
    continue;
  }
  const translated = readFileSync(path, 'utf8');
  const rel = relative(root, path);
  checked += 1;

  // `/diagrams/x.svg` in the source is the same asset as `/diagrams/x.<loc>.svg`
  // in the translation — compare them as equal rather than flagging every page.
  const localise = (href) => href.replace(/\/diagrams\/([\w-]+)\.svg/, `/diagrams/$1.${info.locale}.svg`);

  const a = fences(source);
  const b = fences(translated);
  if (a.length !== b.length) {
    problems.push(`${rel}: ${b.length} code fences, source has ${a.length}`);
  } else {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].body !== b[i].body) problems.push(`${rel}: code fence #${i + 1} body differs from source`);
      if (a[i].info !== b[i].info)
        problems.push(`${rel}: code fence #${i + 1} info string differs (${a[i].info} → ${b[i].info})`);
    }
  }

  const ca = components(source);
  const cb = components(translated);
  for (const name of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
    if ((ca[name] ?? 0) !== (cb[name] ?? 0)) {
      problems.push(`${rel}: <${name}> appears ${cb[name] ?? 0}×, source has ${ca[name] ?? 0}×`);
    }
  }

  const ha = hrefs(source, localise);
  const hb = hrefs(translated, (h) => h);
  if (JSON.stringify(ha) !== JSON.stringify(hb)) {
    const missing = ha.filter((h) => !hb.includes(h));
    const extra = hb.filter((h) => !ha.includes(h));
    problems.push(
      `${rel}: link targets differ${missing.length ? ` — missing ${missing.slice(0, 3).join(', ')}` : ''}${extra.length ? ` — unexpected ${extra.slice(0, 3).join(', ')}` : ''}`,
    );
  }

  const fa = frontmatterKeys(source);
  const fb = frontmatterKeys(translated);
  if (JSON.stringify(fa) !== JSON.stringify(fb)) {
    problems.push(`${rel}: frontmatter keys differ (${fa.join(',')} vs ${fb.join(',')})`);
  }
}

console.log(`checked ${checked} translated page(s) against their English sources`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('every translation matches its source structurally');

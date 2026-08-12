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
 *   - table shape, and the identifier keys in a table's first column
 *
 * It also checks that every English page HAS a translation in every locale —
 * see ENGLISH_ONLY below for why that is a failure rather than a warning.
 *
 * Run: node docs/scripts/check-translations.mjs
 * Exit 0 = every translation matches its source structurally.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'docs');
const LOCALES = ['zh', 'hi', 'es', 'pt', 'ru', 'ja', 'de'];

/**
 * Pages that are deliberately English-only, each with the reason.
 *
 * This list is the ONLY way to declare that: a page missing from a locale is
 * otherwise a hard failure, not a warning.
 *
 * The argument for failing: the requirement on this site is that all eight
 * locales are complete, and a missing page is invisible to every other check
 * here — those only compare translations that already exist, so the one file
 * nobody wrote is exactly the one nothing looked at. That is not hypothetical.
 * `guides/troubleshooting.zh.mdx` was absent for as long as the check existed,
 * while `first-handbook.zh.mdx` linked to it, so Chinese readers followed that
 * link to a 404. A warning would have scrolled past in CI the same way.
 *
 * Failing by default also puts the cost in the right place. Adding an English
 * page and its seven translations in one change is ordinary work; discovering
 * a year later that seven locales silently diverged is not. If a page really
 * should ship English-only, saying so here is one line and leaves a reason in
 * the diff — which is the point. Omission must never be the way that is said.
 */
const ENGLISH_ONLY = new Map([
  // ['reference/some-page.mdx', 'why this one is English-only'],
]);

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

/** Blank out fenced blocks so a `|` inside example code is not read as a table. */
function stripFences(text) {
  return text.replace(/^([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm, (block) =>
    block.replace(/[^\n]/g, ''),
  );
}

/**
 * Markdown tables, as arrays of body rows (the header row included, the
 * `| --- |` separator dropped). Consecutive `|` lines are one table.
 */
function tables(text) {
  const out = [];
  let current = null;
  for (const line of stripFences(text).split('\n')) {
    if (/^\s*\|/.test(line)) {
      (current ??= []).push(line);
    } else if (current) {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out
    .map((rows) => rows.filter((r) => !/^\s*\|[\s:|-]*\|[\s:|-]*$/.test(r)))
    .filter((rows) => rows.length > 0);
}

/** A row's first cell. Splits on unescaped `|` — `enum (a\|b)` is one cell. */
function firstCell(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .split(/(?<!\\)\|/)[0]
    .trim();
}

/**
 * Is this first-column cell an identifier rather than prose? Reference tables
 * are keyed by setting name, flag or env var — all in backticks, none of them
 * translated — whereas a concept page's first column is a sentence. Comparing
 * only the code-like ones is what lets this run over every page instead of
 * just the generated reference.
 */
function isKeyCell(cell) {
  return /^`[^`]+`$/.test(cell);
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

  // Tables. A hand-maintained reference table drifts one row at a time and
  // nothing else here notices: a row dropped from all seven translations
  // leaves every other signal identical. `llmProvider` went missing from all
  // seven copies of the configuration reference exactly this way.
  const ta = tables(source);
  const tb = tables(translated);
  if (ta.length !== tb.length) {
    problems.push(`${rel}: ${tb.length} table(s), source has ${ta.length}`);
  } else {
    for (let i = 0; i < ta.length; i += 1) {
      if (ta[i].length !== tb[i].length) {
        problems.push(`${rel}: table #${i + 1} has ${tb[i].length} row(s), source has ${ta[i].length}`);
        continue;
      }
      // Row counts agree, so compare position by position. Only the cells that
      // are identifiers in English are compared — a concept page's first
      // column is prose, and prose is supposed to differ.
      for (let r = 0; r < ta[i].length; r += 1) {
        const key = firstCell(ta[i][r]);
        if (!isKeyCell(key)) continue;
        const got = firstCell(tb[i][r]);
        if (got !== key) {
          problems.push(`${rel}: table #${i + 1} row ${r + 1} key is ${got || '(empty)'}, source has ${key}`);
        }
      }
    }
  }
}

// Every English page must exist in every locale. This runs over sources rather
// than translations precisely because the failure being caught is a file that
// does not exist — the loop above can never see it.
const englishPages = walk(root).filter((p) => !sourceOf(p));
for (const page of englishPages) {
  const rel = relative(root, page);
  if (ENGLISH_ONLY.has(rel)) continue;
  const ext = /\.mdx?$/.exec(page)[0];
  const stem = page.slice(0, -ext.length);
  const absent = LOCALES.filter((locale) => !existsSync(`${stem}.${locale}${ext}`));
  if (absent.length > 0) {
    problems.push(
      `${rel}: no translation in ${absent.join(', ')} ` +
        `(translate it, or add it to ENGLISH_ONLY with a reason)`,
    );
  }
}

/**
 * A paragraph beginning with `import` or `export` is parsed as an ESM statement.
 *
 * MDX does not care that the rest of the line is prose: it hands the line to
 * acorn, which fails on the first non-JavaScript character. The failure surfaces
 * as `Could not parse import/exports with acorn` pointing at a line number, with
 * no hint that the cause is the first WORD of a sentence — and it only appears
 * at build time, so a translation can pass every structural check here and still
 * break the site.
 *
 * Hit for real in `artifacts.ja.mdx`, where a sentence legitimately opened with
 * "import を通じて…". Any language can do this; a translator has no reason to
 * suspect that one English keyword is reserved at the start of a line.
 */
for (const page of walk(root)) {
  const lines = readFileSync(page, 'utf8').split('\n');
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // A real ESM statement continues with an identifier, `{`, `*` or a quote.
    if (/^(import|export)\b/.test(line) && !/^(import|export)\s*(?:[A-Za-z_$*{]|["'])/.test(line)) {
      problems.push(
        `${relative(root, page)}:${i + 1}: a paragraph starting with "${line.split(/\s/)[0]}" is ` +
          'parsed as an ESM statement — reword so the line does not begin with that word',
      );
    }
  }
}

console.log(
  `checked ${checked} translated page(s) against their English sources, ` +
    `and ${englishPages.length} English page(s) for locale coverage`,
);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('every translation matches its source structurally');

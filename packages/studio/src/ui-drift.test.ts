/**
 * Pins the studio UI's hand-authored `<select>` choice lists against the
 * registry they must never drift from.
 *
 * `gSrcLang` (source language) had drifted to six hard-coded languages
 * against eighteen registered adapters — the exact lesson this registry-driven
 * work exists to fix — so it is now served from `/api/languages` (see
 * server.ts) instead of hand-maintained. The other four lists here
 * (`gDetail`, `gSynth`, `gStrategy`, `gLang`) are small, genuinely fixed
 * enums with no runtime registry of their own, so a live endpoint would be
 * overkill; instead, this test fails the moment any of them stops matching
 * `registry.ts`, which is the alternative the review explicitly allowed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { settingByKey } from '@handbooks/core';

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

/** First quoted string of each `['value', label]` tuple in a `keep('id', [...])` call. */
function keepValues(selectId: string): string[] {
  const call = new RegExp(`keep\\('${selectId}',\\s*\\[(.*?)\\]\\);`, 's').exec(html);
  if (!call) throw new Error(`no keep('${selectId}', …) call found in index.html`);
  return [...call[1]!.matchAll(/\['([^']*)'/g)].map((m) => m[1] as string);
}

/** `value="…"` attributes of every `<option>` inside `<select id="…">…</select>`. */
function selectOptionValues(selectId: string): string[] {
  const select = new RegExp(`<select id="${selectId}">(.*?)</select>`, 's').exec(html);
  if (!select) throw new Error(`no <select id="${selectId}"> found in index.html`);
  return [...select[1]!.matchAll(/value="([^"]*)"/g)].map((m) => m[1] as string);
}

describe('studio UI choice lists match the config registry', () => {
  it('gDetail matches the detail setting', () => {
    expect(keepValues('gDetail').sort()).toEqual([...(settingByKey('detail')?.choices ?? [])].sort());
  });

  it('gSynth matches the synthMode setting', () => {
    expect(keepValues('gSynth').sort()).toEqual([...(settingByKey('synthMode')?.choices ?? [])].sort());
  });

  it('gStrategy matches the strategy setting, plus its own auto/unset sentinel', () => {
    // '' is studio's own "let the work dir decide" sentinel — not a registry
    // choice, so it is stripped before comparing.
    expect(keepValues('gStrategy').filter(Boolean).sort()).toEqual(
      [...(settingByKey('strategy')?.choices ?? [])].sort(),
    );
  });

  it('gLang is served from /api/narrate-languages, not hand-maintained', () => {
    // Regression: this select hard-coded `zh` and `en` while the registry grew
    // to eight prose languages. A hand-written list is a list that goes stale;
    // this one is rendered from the endpoint, under each language's own name.
    expect(html).toContain("keep('gLang', state.narrateLanguages.map(");
    expect(html).toContain('<select id="gLang"></select>');
    expect(selectOptionValues('gLang')).toEqual([]);
  });

  it('gSrcLang is served from /api/languages, not hand-maintained', () => {
    // Regression: this used to be `keep('gSrcLang', [['auto','auto'], ['python',…], …])`
    // with six languages, against eighteen registered adapters.
    expect(html).toContain("keep('gSrcLang', state.languages.map(");
    expect(html).not.toMatch(/keep\('gSrcLang',\s*\[\[/);
  });
});

// ---------------------------------------------------------------------------
// i18n dictionaries
// ---------------------------------------------------------------------------

const UI_LOCALES = ['en', 'zh', 'hi', 'es', 'pt', 'ru', 'ja', 'de'] as const;

/** Evaluate a locale file exactly the way the browser does: a plain script
 *  assigning into `window.HB_DICT`. Returns that locale's dictionary object. */
function loadDict(file: string): Record<string, unknown> {
  const code = readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url)), 'utf8');
  const window: { HB_DICT?: Record<string, Record<string, unknown>> } = {};
  new Function('window', code)(window);
  const locales = Object.keys(window.HB_DICT ?? {});
  if (locales.length !== 1) {
    throw new Error(`${file} must define exactly one locale, got: ${locales.join(', ') || 'none'}`);
  }
  return window.HB_DICT![locales[0]!]!;
}

/** Dotted path of every leaf value, array indices included — so a dictionary
 *  that dropped one list entry (a guide bullet, a home step) fails too. */
function leafKeys(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  const entries = Array.isArray(node)
    ? node.map((v, i) => [String(i), v] as const)
    : Object.entries(node as Record<string, unknown>);
  return entries.flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

describe('studio UI i18n dictionaries', () => {
  it('i18n.en.js and i18n.zh.js parse and carry the same set of leaf keys', () => {
    const en = loadDict('i18n.en.js');
    const zh = loadDict('i18n.zh.js');
    expect(leafKeys(en).length).toBeGreaterThan(100); // a truncated file must not pass as "equal"
    expect(leafKeys(zh).sort()).toEqual(leafKeys(en).sort());
  });

  it('index.html holds no inline dictionary literal any more', () => {
    // The dictionary moved to /i18n.<loc>.js; English is the canonical fallback.
    expect(html).not.toContain('DICT = {');
    expect(html).toContain('const DICT = window.HB_DICT || {};');
  });

  it('index.html loads all eight locale files before the main script', () => {
    for (const loc of UI_LOCALES) {
      expect(html).toContain(`<script src="/i18n.${loc}.js"></script>`);
    }
  });

  it('every locale can say that log lines were dropped', () => {
    // The server bounds what it will hold for a subscriber that stopped reading
    // and drops the oldest lines (see SseStream). A gap nobody is told about is
    // the one outcome worse than the gap, and `t()` echoes the KEY when a
    // dictionary is missing it — so a locale without this entry would render the
    // literal "job.linesDropped" at exactly the moment the user needs a sentence.
    for (const loc of UI_LOCALES) {
      const job = loadDict(`i18n.${loc}.js`).job as Record<string, string>;
      expect(typeof job.linesDropped, loc).toBe('string');
      expect(job.linesDropped, loc).toContain('{0}');
    }
  });
});

describe('the studio UI handles every SSE event the server sends', () => {
  /**
   * The two sides are string literals in different files with nothing between
   * them: an `addEventListener` name that stops matching what the server writes
   * fails silently, because a browser simply ignores an SSE event nobody is
   * listening for. That is how a disclosure becomes a no-op while both halves
   * still look correct on their own.
   */
  const server = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');

  it('listens for each named event the SSE route emits', () => {
    const emitted = [...server.matchAll(/event: ([a-z]+)\\n/g)].map((m) => m[1] as string);
    expect(new Set(emitted)).toEqual(new Set(['progress', 'done', 'dropped']));
    for (const name of new Set(emitted)) {
      expect(html, name).toContain(`evtSource.addEventListener('${name}'`);
    }
  });
});

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
import { NARRATE_LANGS, settingByKey } from '@handbook/core';

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

  it('gLang matches the narrate-language choices', () => {
    expect(selectOptionValues('gLang').sort()).toEqual([...NARRATE_LANGS].sort());
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
});

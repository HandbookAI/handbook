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

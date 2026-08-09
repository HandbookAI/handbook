import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NARRATE_LANGS, checkLanguage, type NarrateLang } from '@handbook/core';
import { makeFixtureModel } from './fixture.test-helper.js';
import { renderAgentSite } from './agent-site.js';
import { renderHtmlSite, renderSinglePageHtml } from './html.js';
import { renderLlmsTxt } from './llms-txt.js';
import { renderMarkdownHandbook } from './markdown.js';

/**
 * Every renderer, in every supported language.
 *
 * The label tables are `Record<NarrateLang, …>`, so a missing language is a
 * compile error — but a table can be complete and still wrong: an entry that
 * drops a substitution, breaks a markdown fence, or leaves an English label in
 * a Japanese handbook compiles perfectly. Only rendering catches that, and
 * rendering in two of eight languages catches a quarter of it.
 */
function withModel(lang: NarrateLang): ReturnType<typeof makeFixtureModel> {
  const model = makeFixtureModel();
  model.lang = lang;
  model.narration.lang = lang;
  return model;
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hb-lang-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(NARRATE_LANGS)('renders in %s', (lang) => {
  const model = withModel(lang);

  it('writes a markdown handbook whose pages are all non-empty', () => {
    withTempDir((dir) => {
      const result = renderMarkdownHandbook(model, dir);
      expect(result.nStagePages).toBeGreaterThan(0);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const body = readFileSync(join(dir, file), 'utf8');
        expect(body.trim().length, file).toBeGreaterThan(0);
        // A label that lost its substitution leaves the placeholder behind.
        expect(body, file).not.toMatch(/\$\{|\[object Object\]|undefined/);
        // Fences must still balance after translation.
        expect((body.match(/^```/gm) ?? []).length % 2, `${file}: unbalanced fences`).toBe(0);
      }
    });
  });

  it('writes an HTML site that declares the language and carries no stray placeholder', () => {
    withTempDir((dir) => {
      const { nPages } = renderHtmlSite(model, dir);
      expect(nPages).toBeGreaterThan(0);
      const overview = readFileSync(join(dir, 'overview.html'), 'utf8');
      expect(overview).toContain(`<html lang="${lang}">`);
      expect(overview).not.toMatch(/\$\{|\[object Object\]|undefined<\//);
      // The count labels are per-language functions; exercise one for real.
      expect(overview).toMatch(/class="chip[^"]*"/);
    });
  });

  it('writes a single-page HTML', () => {
    withTempDir((dir) => {
      const path = join(dir, 'handbook.html');
      const { bytes } = renderSinglePageHtml(model, path);
      expect(bytes).toBeGreaterThan(0);
      const body = readFileSync(path, 'utf8');
      expect(body).toContain(`<html lang="${lang}">`);
      expect(body).not.toMatch(/\[object Object\]/);
    });
  });

  it('writes an agent locator index', () => {
    withTempDir((dir) => {
      const result = renderAgentSite(model, dir);
      expect(result.nStagePages).toBeGreaterThan(0);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const body = readFileSync(join(dir, file), 'utf8');
        expect(body.trim().length, file).toBeGreaterThan(0);
        expect(body, file).not.toMatch(/\[object Object\]/);
      }
    });
  });

  it('writes llms.txt and llms-full.txt', () => {
    withTempDir((dir) => {
      renderLlmsTxt(model, dir);
      for (const name of ['llms.txt', 'llms-full.txt']) {
        const body = readFileSync(join(dir, name), 'utf8');
        expect(body.trim().length, name).toBeGreaterThan(0);
        expect(body, name).not.toMatch(/\[object Object\]/);
      }
    });
  });

  it('discloses mixed analysis fidelity', () => {
    // The disclosure is the promise that a generic-tier language's call facts
    // are not being passed off as a full-tier language's. It must survive
    // translation in every language, or the promise is only kept in two.
    const languages = {
      python: { tier: 'full', callTypes: [], selfAttrs: true, statementSpans: true },
      kotlin: { tier: 'generic', callTypes: [], selfAttrs: false, statementSpans: false },
    } as const;
    withTempDir((dir) => {
      renderHtmlSite(model, dir, { languages });
      const overview = readFileSync(join(dir, 'overview.html'), 'utf8');
      // The generic-tier language is named; the full-tier one is not (naming it
      // would be noise — its facts are as hard as the analyzer gets).
      expect(overview).toContain('kotlin');
      expect(overview).toContain('callout');
      expect(overview).not.toMatch(/\[object Object\]|undefined/);
    });
    withTempDir((dir) => {
      renderMarkdownHandbook(model, dir, { languages });
      const overview = readFileSync(join(dir, 'overview.md'), 'utf8');
      expect(overview).toContain('kotlin');
    });
    withTempDir((dir) => {
      const path = join(dir, 'handbook.html');
      renderSinglePageHtml(model, path, { languages });
      expect(readFileSync(path, 'utf8')).toContain('kotlin');
    });
  });

  it('renders function notes, line ranges and call facts', () => {
    // Every one of these is a per-language formatter (`lines(a, b)`,
    // `functionCount(n)`, the call-facts sentence). They only run when a deep
    // card is rendered, so a fixture without one leaves them untested in all
    // eight languages at once.
    withTempDir((dir) => {
      renderHtmlSite(model, dir);
      const page = readFileSync(join(dir, 'stage-1.html'), 'utf8');
      expect(page).toContain('loader.loadAll');
      expect(page).toMatch(/10.{0,3}42/); // the line range, however it is punctuated
      expect(page).not.toMatch(/\[object Object\]|NaN/);
    });
    withTempDir((dir) => {
      renderMarkdownHandbook(model, dir);
      const stage = readFileSync(join(dir, 'stage-1.md'), 'utf8');
      expect(stage).toContain('loader.loadAll');
      expect(stage).not.toMatch(/\[object Object\]|NaN/);
    });
  });
});

describe('no language table is a copy of the English one', () => {
  /**
   * The compile-time check proves a table HAS eight entries; it cannot prove
   * the eighth is not the English entry pasted in. Comparing the rendered
   * chrome against the English render is what proves that, and it does not
   * depend on the fixture's own prose — which is English in every case, so
   * asking a language detector about the whole page would only ever find the
   * fixture.
   */
  const englishChrome = withTempDir((dir) => {
    renderHtmlSite(withModel('en'), dir);
    return readFileSync(join(dir, 'stage-1.html'), 'utf8');
  });

  it.each(NARRATE_LANGS.filter((l) => l !== 'en'))('%s renders different chrome', (lang) => {
    withTempDir((dir) => {
      renderHtmlSite(withModel(lang), dir);
      const page = readFileSync(join(dir, 'stage-1.html'), 'utf8');
      expect(page, `${lang} produced byte-identical output to English`).not.toBe(englishChrome);
      // And specifically the labels, not just the `lang` attribute: strip that
      // one known difference and the pages must still differ.
      const normalise = (html: string): string => html.replace(/<html lang="[a-z]{2}">/, '<html>');
      expect(normalise(page), `${lang} differs from English only by its lang attribute`).not.toBe(
        normalise(englishChrome),
      );
    });
  });

  it.each(['zh', 'ja', 'ru', 'hi'] as NarrateLang[])('%s chrome is written in its own script', (lang) => {
    withTempDir((dir) => {
      renderHtmlSite(withModel(lang), dir);
      const page = readFileSync(join(dir, 'stage-1.html'), 'utf8');
      // Pull the section headings out — pure chrome, no fixture prose.
      const headings = [...page.matchAll(/<h2 id="[^"]*">([^<]*)</g)].map((m) => m[1]).join(' ');
      expect(headings.length, 'no headings found to check').toBeGreaterThan(0);
      const verdict = checkLanguage(headings, lang);
      expect(verdict.ok, `${lang} headings "${headings}": ${verdict.detail}`).toBe(true);
    });
  });
});

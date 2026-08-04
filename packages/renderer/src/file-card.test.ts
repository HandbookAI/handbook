import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { fileOneLiner, renderFileCardMd } from './file-card.js';
import { ENGINE_TEST, LOADER, PARSER, makeFixtureModel } from './fixture.test-helper.js';

const model = makeFixtureModel();
const loader = model.cards[LOADER];
const parser = model.cards[PARSER];
const engineTest = model.cards[ENGINE_TEST];

describe('fileOneLiner', () => {
  it('renders `rel` — purpose [role]', () => {
    expect(fileOneLiner(LOADER, loader)).toBe(
      '- `src/ingest/loader.ts` — Loads raw source files into the ingestion pipeline. [orchestration]',
    );
  });
});

describe('renderFileCardMd (en)', () => {
  const md = renderFileCardMd(LOADER, loader, 'en');

  it('starts at H3 with the backticked path', () => {
    expect(md.startsWith('### `src/ingest/loader.ts`')).toBe(true);
  });

  it('renders the role badge with the lifecycle badge when set', () => {
    expect(md).toContain('`orchestration` · `startup`');
  });

  it('omits the lifecycle badge when it is "none"', () => {
    const parserMd = renderFileCardMd(PARSER, parser, 'en');
    expect(parserMd).toContain('`domain_logic`');
    expect(parserMd).not.toContain('· `none`');
  });

  it('prefers the description over the purpose', () => {
    expect(md).toContain('Coordinates discovery and loading of raw sources');
  });

  it('falls back to purpose when no description exists', () => {
    expect(renderFileCardMd(PARSER, parser, 'en')).toContain('Parses raw sources into AST records.');
  });

  it('renders the Function details section with per-function headings', () => {
    expect(md).toContain('#### Function details');
    expect(md).toContain('##### `loader.loadAll` (lines 10–42)');
    expect(md).toContain('```\nexport async function loadAll(root: string): Promise<Source[]>\n```');
  });

  it('renders Purpose / Data flow / Call relations paragraphs', () => {
    expect(md).toContain('**Purpose**: Walk the tree and load every source.');
    expect(md).toContain('**Data flow**: root path in, Source[] out.');
    expect(md).toContain('**Call relations**: Fans out to per-format readers.');
  });

  it('caps call-graph name lists at 10 leaf names with (+K more)', () => {
    expect(md).toContain('*Call graph*: calls 12 internal (');
    expect(md).toContain('(+2 more)');
    expect(md).toContain('reader1');
    expect(md).not.toContain('reader11');
    expect(md).toContain('called by 1 (run)');
    expect(md).toContain('1 external calls (readFile)');
  });

  it('skips Function details when the card has no functions', () => {
    expect(renderFileCardMd(ENGINE_TEST, engineTest, 'en')).not.toContain('#### Function details');
  });

  it('a ``` line inside a signature cannot break out of the code fence', () => {
    // A signature is code text: an LLM/analyzer can emit one that itself
    // contains a ``` line. A fixed 3-backtick fence would close there and the
    // trailing text would render as live markdown (headings, raw HTML) in the
    // handbook. The fence must be sized to enclose the whole signature.
    const poisoned = structuredClone(loader);
    poisoned.functions![0].signature = 'function f()\n```\n## INJECTED HEADING\n<img src=x onerror=alert(1)>';
    const out = renderFileCardMd(LOADER, poisoned, 'en');
    const html = new MarkdownIt({ html: false, linkify: false }).render(out);
    // The injected heading and tag stay inert inside the code block.
    expect(html).not.toContain('<h2>INJECTED');
    expect(html).not.toContain('INJECTED HEADING</h2>');
    expect(html).toContain('## INJECTED HEADING'); // present, but escaped in <pre><code>
  });
});

describe('renderFileCardMd — source links (opt-in)', () => {
  it('turns the heading path into a link when sourceBaseUrl is set', () => {
    const md = renderFileCardMd(LOADER, loader, 'en', { sourceBaseUrl: 'https://example.com/repo/' });
    expect(md.startsWith('### [`src/ingest/loader.ts`](https://example.com/repo/src/ingest/loader.ts)')).toBe(true);
  });

  it('URL-encodes path segments but keeps the separators', () => {
    const md = renderFileCardMd('src/a b/c#d.ts', loader, 'en', { sourceBaseUrl: 'https://example.com/x' });
    expect(md.startsWith('### [`src/a b/c#d.ts`](https://example.com/x/src/a%20b/c%23d.ts)')).toBe(true);
  });

  it('stays byte-identical when the option is absent or empty', () => {
    expect(renderFileCardMd(LOADER, loader, 'en', {})).toBe(renderFileCardMd(LOADER, loader, 'en'));
  });
});

describe('renderFileCardMd (zh)', () => {
  const md = renderFileCardMd(LOADER, loader, 'zh');

  it('uses the full zh label set', () => {
    expect(md).toContain('#### 函数细节');
    expect(md).toContain('##### `loader.loadAll` （行 10–42）');
    expect(md).toContain('**作用**：');
    expect(md).toContain('**数据流**：');
    expect(md).toContain('**调用关系**：');
    expect(md).toContain('*调用图*：');
  });
});

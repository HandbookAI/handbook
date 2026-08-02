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

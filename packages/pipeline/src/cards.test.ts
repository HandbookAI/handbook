/**
 * Regressions for the card-attribution rules, all drawn from review R1.
 *
 * Every case here once produced a card that LOOKED fine: coverage reported the
 * file as described, no warning was logged, and the content belonged to
 * something else — a function note, a sibling file, or nothing at all.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsonBlock, type CodeGraph, type Logger } from '@handbook/core';
import type { ChatClient, ChatResult } from '@handbook/llm';
import { extractCardEntries, generateCards } from './cards.js';
import { WorkDir } from './workdir.js';

function fixture(files: readonly string[]): { sourceRoot: string; graph: CodeGraph } {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-cards-'));
  for (const file of files) {
    const dir = file.includes('/') ? join(sourceRoot, file.slice(0, file.lastIndexOf('/'))) : sourceRoot;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(sourceRoot, file), '// source\n');
  }
  return {
    sourceRoot,
    graph: {
      version: 1,
      nodes: {},
      edges: [],
      selfAttrs: {},
      metadata: {
        generatedAt: '',
        language: 'typescript',
        sourceRoot,
        scannedFiles: [...files],
        nInternalFunctions: 0,
        nBoundaryNodes: 0,
        nEdges: 0,
        policy: 'test',
      },
    } as unknown as CodeGraph,
  };
}

function replyClient(reply: string): { client: ChatClient; calls: () => number } {
  let calls = 0;
  const client: ChatClient = {
    model: 'test',
    async complete(): Promise<ChatResult> {
      calls += 1;
      return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 };
    },
  };
  return { client, calls: () => calls };
}

function collectingLogger(warnings: string[]): Logger {
  const logger: Logger = {
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}

const fence = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe('extractCardEntries', () => {
  it('accepts the shapes models actually send', () => {
    const card = { file: 'a.ts', purpose: 'p', role: 'util' };
    expect(extractCardEntries({ purposes: [card] })).toEqual([card]);
    expect(extractCardEntries([card])).toEqual([card]);
    expect(extractCardEntries({ files: [card] })).toEqual([card]);
    expect(extractCardEntries({ purpose: 'p', role: 'util' })).toEqual([{ purpose: 'p', role: 'util' }]);
    expect(extractCardEntries({ 'a.ts': { purpose: 'p' } })).toEqual([{ purpose: 'p', file: 'a.ts' }]);
  });

  it('refuses a function note masquerading as a file card (R1 F1)', () => {
    const note = { qualname: 'Queue.push', purpose: 'Adds a job.', data_flow: 'job in', relations: 'producer' };
    expect(extractCardEntries([note])).toEqual([]);
    expect(extractCardEntries(note)).toEqual([]);
  });

  it('refuses an object whose only card-ish key is the generic `purpose`', () => {
    expect(extractCardEntries({ purpose: 'p' })).toEqual([]);
  });
});

describe('generateCards attribution', () => {
  it('does not attribute a card to a file the reply never named (R1 F7 case 2)', async () => {
    const { sourceRoot, graph } = fixture(['src/core/index.ts']);
    const { client } = replyClient(
      fence({ purposes: [{ file: 'packages/llm/src/client.ts', purpose: 'The chat client.', role: 'io_transport' }] }),
    );
    const warnings: string[] = [];
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const result = await generateCards({
      client,
      graph,
      sourceRoot,
      work,
      batchSize: 1,
      logger: collectingLogger(warnings),
    });
    expect(result.cards['src/core/index.ts']?.purpose).toBe('');
    expect(result.coverage).toMatchObject({ nDescribed: 0, missing: ['src/core/index.ts'] });
    expect(warnings.join(' ')).toMatch(/no usable entries/);
  });

  it('lets an unnamed entry inherit a single-file batch', async () => {
    const { sourceRoot, graph } = fixture(['src/only.ts']);
    const { client } = replyClient(fence({ purpose: 'Does the one thing.', role: 'util' }));
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const result = await generateCards({ client, graph, sourceRoot, work, batchSize: 1 });
    expect(result.cards['src/only.ts']?.purpose).toBe('Does the one thing.');
    expect(result.coverage.nDescribed).toBe(1);
  });

  it('never lets a loose path overwrite an explicitly named card (R1 F7 case 1)', async () => {
    const { sourceRoot, graph } = fixture(['src/a/config.ts', 'src/b/main.ts']);
    const { client } = replyClient(
      fence({
        purposes: [
          { file: 'src/a/config.ts', purpose: 'CORRECT: the a-side config.', role: 'config' },
          { file: 'src/b/config.ts', purpose: 'WRONG: a path not in the batch.', role: 'util' },
        ],
      }),
    );
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const result = await generateCards({ client, graph, sourceRoot, work, batchSize: 2 });
    expect(result.cards['src/a/config.ts']?.purpose).toBe('CORRECT: the a-side config.');
  });

  it('treats an entry with no purpose as undescribed, and retries it (R1 F6)', async () => {
    const { sourceRoot, graph } = fixture(['src/a.ts', 'src/b.ts']);
    // Prose under a key the reader does not know: the entry exists, the content
    // does not. That must not count as coverage nor skip the single-file retry.
    const { client, calls } = replyClient(
      fence({
        purposes: [
          { file: 'src/a.ts', summary: 'the real description went here', role: 'util' },
          { file: 'src/b.ts', purpose: 'A good card.', role: 'util' },
        ],
      }),
    );
    const warnings: string[] = [];
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const result = await generateCards({
      client,
      graph,
      sourceRoot,
      work,
      batchSize: 2,
      logger: collectingLogger(warnings),
    });
    expect(result.coverage.missing).toEqual(['src/a.ts']);
    expect(calls()).toBeGreaterThan(1); // the tier-2 retry ran
  });

  it('keeps a reply that yielded nothing, under a name that cannot collide (R1 F14)', async () => {
    const { sourceRoot, graph } = fixture(['中文/文件.ts', '中文/别的.ts']);
    const { client } = replyClient(fence({ nothing: 'usable' }));
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    await generateCards({ client, graph, sourceRoot, work, batchSize: 1 }).catch(() => undefined);
    const kept = readdirSync(join(work.cardsDir, '_rejected'));
    expect(kept).toHaveLength(2); // distinct names for two CJK paths
    expect(new Set(kept).size).toBe(2);
  });

  it('aborts only when total failure is systemic, and says what it kept (R1 F11)', async () => {
    const failing: ChatClient = {
      model: 'test',
      async complete(): Promise<ChatResult> {
        throw new Error('LLM returned empty content (finish_reason=stop)');
      },
    };
    // A one-file repo: one flaky call is not a broken configuration.
    const small = fixture(['src/only.ts']);
    const smallWork = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const smallResult = await generateCards({
      client: failing,
      graph: small.graph,
      sourceRoot: small.sourceRoot,
      work: smallWork,
      batchSize: 1,
    });
    expect(smallResult.coverage.nDescribed).toBe(0);

    // Three files, all failing: systemic. The message must name the evidence.
    const big = fixture(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const bigWork = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    await expect(
      generateCards({
        client: failing,
        graph: big.graph,
        sourceRoot: big.sourceRoot,
        work: bigWork,
        batchSize: 1,
      }),
    ).rejects.toThrow(/all 3 files failed to be described after 3 LLM call\(s\)/);
  });

  it('does not blame the model when no call was made (R1 F11)', async () => {
    const { sourceRoot, graph } = fixture(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const { client, calls } = replyClient(fence({}));
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const result = await generateCards({
      client,
      graph,
      sourceRoot,
      work,
      batchSize: 1,
      onlyFiles: ['src/removed.ts'], // resolves to nothing
    });
    expect(calls()).toBe(0);
    expect(result.coverage.nDescribed).toBe(0);
    expect(existsSync(join(work.cardsDir, '_rejected'))).toBe(false);
  });
});

describe('loadCards skips unparseable files instead of crashing the run', () => {
  const goodCard = (file: string): string =>
    JSON.stringify({ version: 1, file, purpose: `p:${file}`, role: 'util', lifecycle: 'none' });

  it('skips a syntactically-broken .json (corrupt/partially-synced) and keeps the good cards', () => {
    // Its docstring promises "Unparseable files are skipped": a foreign json that
    // fails SCHEMA validation was already tolerated, but one that fails to PARSE
    // (a half-synced file, an editor scratch, a foreign tool's output) used to
    // throw a raw SyntaxError and abort the caller entirely.
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    mkdirSync(join(work.cardsDir, 'src'), { recursive: true });
    writeFileSync(work.cardPath('src/good.ts'), goodCard('src/good.ts'));
    writeFileSync(join(work.cardsDir, 'broken.json'), '{ not valid json ,,,');
    writeFileSync(join(work.cardsDir, 'foreign.json'), JSON.stringify({ unrelated: true }));
    const cards = work.loadCards();
    expect(Object.keys(cards)).toEqual(['src/good.ts']);
    expect(cards['src/good.ts']?.purpose).toBe('p:src/good.ts');
  });

  it('a corrupt json in the cards dir does not abort a resume pass', async () => {
    const { sourceRoot, graph } = fixture(['src/a.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    mkdirSync(work.cardsDir, { recursive: true });
    writeFileSync(join(work.cardsDir, 'left-behind.json'), 'this is not json');
    const { client } = replyClient(
      fence({ purposes: [{ file: 'src/a.ts', purpose: 'described anyway', role: 'util' }] }),
    );
    const result = await generateCards({ client, graph, sourceRoot, work, resume: true });
    expect(result.coverage.nDescribed).toBe(1);
    expect(result.cards['src/a.ts']?.purpose).toBe('described anyway');
  });
});

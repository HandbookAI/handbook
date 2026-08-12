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
import { buildTypeInventory } from './inventory.js';
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
    const note = {
      qualname: 'Queue.push',
      purpose: 'Adds a job.',
      data_flow: 'job in',
      relations: 'producer',
    };
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
      fence({
        purposes: [{ file: 'packages/llm/src/client.ts', purpose: 'The chat client.', role: 'io_transport' }],
      }),
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

describe('cards for deleted files are evicted, keyed on the graph and not on the batch', () => {
  /**
   * The eviction itself is easy; keying it on the wrong list destroys a work
   * dir. Two lists sit side by side in `generateCards`: `files`, every file in
   * the graph, and `todo`, which `onlyFiles` narrows to the handful a resync
   * touched. Pruning to `todo` deletes every other card in the handbook and
   * reports success.
   *
   * The subset test below is the one that bites: swap `files` for `todo` in the
   * eviction call and it goes red while everything else stays green.
   */
  it('removes the card of a file that has left the codebase', async () => {
    const { sourceRoot, graph } = fixture(['src/a.ts', 'src/b.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-evict-full-')));
    work.saveCard({
      version: 1,
      file: 'src/deleted.ts',
      purpose: 'a file that no longer exists',
      role: 'other',
      lifecycle: 'none',
    });
    const { client } = replyClient(
      fence({ files: [{ file: 'src/a.ts', purpose: 'p', role: 'util', lifecycle: 'none' }] }),
    );
    const result = await generateCards({ client, graph, sourceRoot, work, batchSize: 8 });
    expect(Object.keys(result.cards)).not.toContain('src/deleted.ts');
    expect(Object.keys(work.loadCards())).not.toContain('src/deleted.ts');
  });

  it('keeps every other card when the pass is a subset (resync)', async () => {
    const { sourceRoot, graph } = fixture(['src/a.ts', 'src/b.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-evict-subset-')));
    for (const file of ['src/a.ts', 'src/b.ts']) {
      work.saveCard({ version: 1, file, purpose: `about ${file}`, role: 'util', lifecycle: 'none' });
    }
    const { client } = replyClient(
      fence({ files: [{ file: 'src/a.ts', purpose: 'refreshed', role: 'util', lifecycle: 'none' }] }),
    );
    await generateCards({ client, graph, sourceRoot, work, batchSize: 8, onlyFiles: ['src/a.ts'] });
    // `src/b.ts` was not in this pass and is not gone from the codebase. Its
    // card must survive.
    expect(Object.keys(work.loadCards()).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('says which cards it removed rather than shrinking the handbook silently', async () => {
    const { sourceRoot, graph } = fixture(['src/a.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-evict-log-')));
    work.saveCard({
      version: 1,
      file: 'src/ghost.ts',
      purpose: 'gone',
      role: 'other',
      lifecycle: 'none',
    });
    const lines: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (m) => lines.push(m),
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const { client } = replyClient(
      fence({ files: [{ file: 'src/a.ts', purpose: 'p', role: 'util', lifecycle: 'none' }] }),
    );
    await generateCards({ client, graph, sourceRoot, work, batchSize: 8, logger });
    expect(lines.some((l) => l.includes('src/ghost.ts') && /no longer in the codebase/.test(l))).toBe(true);
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

describe('generateCards cancellation — the degradation tiers are loops too', () => {
  /**
   * A ChatClient that answers nothing usable and ignores the signal entirely.
   *
   * That is the honest shape of the problem: `MockChatClient` ignores it, and so
   * does a `CachedChatClient` serving a hit. Relying on the client to reject is
   * what left the fallback tiers spending calls after a cancel — the checkpoint
   * has to live in the pass.
   */
  function deafClient(
    abortOnCall: number,
    controller: AbortController,
  ): { client: ChatClient; n: () => number } {
    let calls = 0;
    const client: ChatClient = {
      model: 'test',
      async complete(): Promise<ChatResult> {
        calls += 1;
        if (calls === abortOnCall) controller.abort();
        return { text: 'nothing usable here', json: undefined, elapsedSec: 0 };
      },
    };
    return { client, n: () => calls };
  }

  it('starts no single-file retry once the signal has fired mid-batch', async () => {
    const { sourceRoot, graph } = fixture(['a.ts', 'b.ts', 'c.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const controller = new AbortController();
    const { client, n } = deafClient(1, controller);
    const error = await generateCards({
      client,
      graph,
      sourceRoot,
      work,
      batchSize: 3,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(n()).toBe(1); // tier 2 would have retried all three files alone
    // And nothing was backfilled: an aborted pass writes no coverage claim.
    expect(existsSync(join(work.cardsDir, '_coverage.json'))).toBe(false);
  });

  it('starts no further function chunk once the signal has fired mid-file', async () => {
    // Tier 3 walks a file's functions chunk by chunk. Nothing between the
    // iterations consulted the signal, so a cancel mid-file bought the rest.
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-cards-deep-'));
    writeFileSync(
      join(sourceRoot, 'a.ts'),
      'function one() {\n  return 1;\n}\nfunction two() {\n  return 2;\n}\n',
    );
    const node = (id: string, lineStart: number, lineEnd: number): Record<string, unknown> => ({
      kind: 'internal',
      id,
      file: 'a.ts',
      qualname: id,
      name: id,
      className: undefined,
      lineStart,
      lineEnd,
      signature: `function ${id}()`,
      synthetic: false,
    });
    const graph = {
      version: 1,
      nodes: { one: node('one', 1, 3), two: node('two', 4, 6) },
      edges: [],
      selfAttrs: {},
      metadata: {
        generatedAt: '',
        language: 'typescript',
        sourceRoot,
        scannedFiles: ['a.ts'],
        nInternalFunctions: 2,
        nBoundaryNodes: 0,
        nEdges: 0,
        policy: 'test',
      },
    } as unknown as CodeGraph;
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-work-')));
    const controller = new AbortController();
    // Call 1 is the whole-file pass (batch of one, so tier 2 is skipped); call 2
    // is the first function chunk, and it is where the cancel lands.
    const { client, n } = deafClient(2, controller);
    const error = await generateCards({
      client,
      graph,
      sourceRoot,
      work,
      batchSize: 1,
      detail: 'deep',
      chunkChars: 1, // one function per chunk
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(n()).toBe(2); // the second chunk was never asked for
  });
});

describe('buildTypeInventory', () => {
  const graphWith = (types: CodeGraph['types']): CodeGraph => {
    const { graph } = fixture(['a.ts']);
    return { ...graph, types };
  };
  const type = (name: string, file: string, lineStart: number): NonNullable<CodeGraph['types']>[number] => ({
    id: `type:${name}`,
    name,
    qualname: name,
    file,
    lineStart,
    lineEnd: lineStart + 2,
    kind: 'interface',
    signature: `interface ${name}`,
    container: null,
  });

  it('returns undefined when the graph has no types field at all', () => {
    // Not `{}`: "no adapter in this run extracts types" and "every file happens to
    // declare none" must stay distinguishable, or the cards pass cannot pass the
    // distinction on and the artifact discloses the wrong thing.
    expect(buildTypeInventory(graphWith(undefined))).toBeUndefined();
  });

  it('returns an empty record when the adapter looked and found none', () => {
    expect(buildTypeInventory(graphWith([]))).toEqual({});
  });

  it('groups by file and orders by declaration line', () => {
    const byFile = buildTypeInventory(
      graphWith([type('Late', 'a.ts', 40), type('Early', 'a.ts', 5), type('Other', 'b.ts', 9)]),
    );
    expect(byFile?.['a.ts']?.map((t) => t.name)).toEqual(['Early', 'Late']);
    expect(byFile?.['b.ts']?.map((t) => t.name)).toEqual(['Other']);
  });

  it('carries the parsed span and the declaration text, and no prose fields', () => {
    // A TypeNote is a pure parser fact; three permanently-empty prose strings would
    // be an invitation to fill them and would blur invariant 1's line.
    const note = buildTypeInventory(graphWith([type('Model', 'a.ts', 12)]))?.['a.ts']?.[0];
    expect(note).toEqual({
      name: 'Model',
      qualname: 'Model',
      kind: 'interface',
      lineRange: [12, 14],
      signature: 'interface Model',
      container: null,
    });
  });
});

describe('generateCards — type notes', () => {
  const types: NonNullable<CodeGraph['types']> = [
    {
      id: 'type:a.Model',
      name: 'Model',
      qualname: 'Model',
      file: 'a.ts',
      lineStart: 3,
      lineEnd: 8,
      kind: 'interface',
      signature: 'export interface Model',
      container: null,
    },
  ];

  it('attaches them in BRIEF mode, where function notes do not exist', () => {
    // Gating a parser fact on the LLM detail level would withhold it for nothing:
    // a type note has no prose to wait for.
    const { sourceRoot, graph } = fixture(['a.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-cards-types-')));
    return generateCards({
      client: replyClient(fence({ purposes: [{ file: 'a.ts', purpose: 'p', role: 'util' }] })).client,
      graph: { ...graph, types },
      sourceRoot,
      work,
      detail: 'brief',
    }).then(({ cards }) => {
      expect(cards['a.ts']?.functions).toBeUndefined();
      expect(cards['a.ts']?.types?.map((t) => t.name)).toEqual(['Model']);
    });
  });

  it('keeps them on a BACKFILLED card the model failed to describe', async () => {
    // Invariant 1: a file whose card generation failed still appears, with an empty
    // description. Dropping the parser facts there too would make a file the model
    // could not describe also unfindable by name.
    // `b.ts` and `c.ts` succeed so the systemic-failure guard stays quiet: this is
    // about ONE file degrading, not a broken configuration.
    const { sourceRoot, graph } = fixture(['a.ts', 'b.ts', 'c.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-cards-backfill-')));
    const { cards, coverage } = await generateCards({
      client: replyClient(
        fence({
          purposes: [
            { file: 'b.ts', purpose: 'p', role: 'util' },
            { file: 'c.ts', purpose: 'p', role: 'util' },
          ],
        }),
      ).client,
      graph: { ...graph, types },
      sourceRoot,
      work,
      detail: 'brief',
    });
    expect(coverage.missing).toContain('a.ts');
    expect(cards['a.ts']?.purpose).toBe('');
    expect(cards['a.ts']?.types?.map((t) => t.name)).toEqual(['Model']);
  });

  it('omits the field entirely for a file that declares none', async () => {
    const { sourceRoot, graph } = fixture(['a.ts', 'b.ts']);
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-cards-none-')));
    const { cards } = await generateCards({
      client: replyClient(
        fence({
          purposes: [
            { file: 'a.ts', purpose: 'p', role: 'util' },
            { file: 'b.ts', purpose: 'p', role: 'util' },
          ],
        }),
      ).client,
      graph: { ...graph, types },
      sourceRoot,
      work,
      detail: 'brief',
    });
    expect(cards['a.ts']?.types).toBeDefined();
    expect(cards['b.ts']?.types).toBeUndefined();
  });
});

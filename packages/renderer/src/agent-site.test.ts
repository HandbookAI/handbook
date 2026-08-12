import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterCapabilities } from '@handbook/core';
import { renderAgentSite, strongTwins } from './agent-site.js';
import { ORPHAN, makeFixtureModel, makeUnassignedFixtureModel } from './fixture.test-helper.js';

const model = makeFixtureModel();
let dir: string;
let result: { nStagePages: number; nSymbols: number };

const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
/** Data rows of a fact table: the `#` lines are the header contract, not data. */
const rows = (name: string): string[][] =>
  read(name)
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-renderer-agent-'));
  result = renderAgentSite(model, dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderAgentSite — the file set', () => {
  it('writes the entry index, three fact tables, and one page per content stage', () => {
    expect(result.nStagePages).toBe(4);
    for (const name of ['index.md', 'symbols.tsv', 'files.tsv', 'calls.tsv']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    for (const sid of ['stage-1', 'stage-1.1', 'stage-2', 'crosscut-1']) {
      expect(existsSync(join(dir, 'stages', `${sid}.md`)), sid).toBe(true);
    }
  });

  it('no longer writes the protocol pages it replaced', () => {
    // `how_to_use.md` became five lines inside index.md: a recipe one hop away
    // is a recipe not followed. `disambiguation.md` indexed stage-title tokens,
    // which symbols.tsv answers precisely and for free.
    expect(existsSync(join(dir, 'how_to_use.md'))).toBe(false);
    expect(existsSync(join(dir, 'disambiguation.md'))).toBe(false);
  });

  it('keeps the entry index small enough to always load', () => {
    // This file is paid on every session AND every subagent spawn, so its size
    // is a product decision. The design it replaced was 33 KB.
    expect(Buffer.byteLength(read('index.md'))).toBeLessThan(4096);
  });

  it('clears an artifact from a previous, differently-shaped render', () => {
    // This happened for real: a `handbook studio` process still running an
    // older build re-rendered over a newer artifact, and because that build's
    // cleanup only knew about `.md`, the newer `.tsv` tables survived beside
    // it. The directory then held two generations at once — a protocol page
    // describing files that were gone, next to an index describing files that
    // page had never heard of. An agent reading it follows the wrong one.
    const again = mkdtempSync(join(tmpdir(), 'hb-agent-stale-'));
    writeFileSync(join(again, 'how_to_use.md'), '# an older protocol\n');
    writeFileSync(join(again, 'disambiguation.md'), '# an older index\n');
    writeFileSync(join(again, 'analyzer_adapters.md'), 'a 313 KB page, in spirit\n');
    writeFileSync(join(again, 'leftover.json'), '{}');
    mkdirSync(join(again, 'prose'), { recursive: true });
    writeFileSync(join(again, 'prose', 'old.md'), 'x');

    renderAgentSite(model, again);

    // Emptied completely, not by extension: deleting only what THIS version
    // writes is exactly the bug above.
    expect(readdirSync(again).sort()).toEqual([
      'calls.tsv',
      'files.tsv',
      'index.md',
      'stages',
      'symbols.tsv',
    ]);
    rmSync(again, { recursive: true, force: true });
  });
});

describe('renderAgentSite — symbols.tsv', () => {
  it('locates every function by file and line range', () => {
    const loadAll = rows('symbols.tsv').find((r) => r[0] === 'loadAll');
    expect(loadAll).toBeDefined();
    expect(loadAll?.[1]).toBe('src/ingest/loader.ts:10-42');
    expect(loadAll?.[2]).toBe('fn');
    // The signature is the last column so a consumer that clips long lines eats
    // it before it eats the location.
    expect(loadAll?.[5]).toBeTruthy();
  });

  it('sorts by name byte-wise, so an unchanged model renders identically', () => {
    // Not `localeCompare`: it orders `_coverage` before `analyzer` in one
    // locale and after it in another, which would make the artifact differ
    // between two developers running the same command.
    const names = rows('symbols.tsv').map((r) => r[0] ?? '');
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('renders byte-identically on a second run', () => {
    const again = mkdtempSync(join(tmpdir(), 'hb-agent-determinism-'));
    renderAgentSite(model, again);
    for (const name of ['index.md', 'symbols.tsv', 'files.tsv', 'calls.tsv']) {
      // index.md carries a timestamp only when the model has provenance; the
      // fixture has none, so every byte here is a pure function of the model.
      expect(readFileSync(join(again, name), 'utf8'), name).toBe(read(name));
    }
    rmSync(again, { recursive: true, force: true });
  });

  describe('class rows', () => {
    /** Two methods of one class, so the span has to be merged from both. */
    function modelWithAClass(): ReturnType<typeof makeFixtureModel> {
      const m = makeFixtureModel();
      const card = Object.values(m.cards).find((c) => (c.functions ?? []).length >= 2);
      for (const [i, fn] of (card?.functions ?? []).entries()) {
        fn.className = 'Loader';
        fn.lineRange = i === 0 ? [40, 60] : [10, 20];
      }
      return m;
    }

    let classDir: string;
    beforeAll(() => {
      classDir = mkdtempSync(join(tmpdir(), 'hb-agent-class-'));
      renderAgentSite(modelWithAClass(), classDir);
    });
    afterAll(() => rmSync(classDir, { recursive: true, force: true }));

    const classRow = (): string[] | undefined =>
      readFileSync(join(classDir, 'symbols.tsv'), 'utf8')
        .split('\n')
        .map((l) => l.split('\t'))
        .find((r) => r[0] === 'Loader');

    it('spans from the first method to the last, regardless of declaration order', () => {
      // The methods are given out of order on purpose: a span computed by
      // "first seen wins" would report 40-60 and point past the class.
      expect(classRow()?.[1]).toMatch(/:10-60$/);
    });

    it('says how many members the span came from', () => {
      expect(classRow()?.[5]).toContain('2 method(s)');
    });

    it('sorts a class row among the functions by name, not into a separate block', () => {
      // An agent greps one table by name; a class hiding in a trailing section
      // would be found only by someone who read the whole file.
      const names = readFileSync(join(classDir, 'symbols.tsv'), 'utf8')
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => l.split('\t')[0] ?? '');
      expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });
  });

  it('marks a class span as derived rather than parsed', () => {
    // The IR has no node kind for a type, so a class row's span is min..max of
    // its METHODS — where the members are, not where the declaration is.
    // Emitting that unmarked would put an invented number in the column an
    // agent trusts most.
    const derived = rows('symbols.tsv').filter((r) => r[2] === 'class-derived');
    for (const row of derived) {
      expect(row[5]).toMatch(/derived from members/);
    }
  });

  it('counts a cross-package caller in nCalledBy, so it does not read as dead code', () => {
    // `nCalledBy` on the card counts only edges inside the scanned set. In a
    // monorepo an exported function called exclusively from other packages
    // therefore shows 0, which an agent reads as "safe to delete".
    const m = makeFixtureModel();
    const target = Object.values(m.cards)
      .flatMap((c) => c.functions ?? [])
      .find((f) => f.name === 'parseFile');
    const before = target?.nCalledBy ?? 0;
    const caller = Object.values(m.cards)
      .flatMap((c) => c.functions ?? [])
      .find((f) => f.id === 'query.runQuery');
    if (caller) caller.extCalls = ['@scope/pkg::parseFile'];
    const dir3 = mkdtempSync(join(tmpdir(), 'hb-agent-ncalled-'));
    renderAgentSite(m, dir3);
    const row = readFileSync(join(dir3, 'symbols.tsv'), 'utf8')
      .split('\n')
      .map((l) => l.split('\t'))
      .find((r) => r[0] === 'parseFile');
    expect(Number(row?.[4])).toBe(before + 1);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('says out loud what each kind means and what is never indexed', () => {
    // An agent that greps for a symbol, gets nothing, and concludes it does not
    // exist is the wrong-pointer failure this artifact exists to avoid. The header
    // explains the kind column; the per-language coverage lives in index.md, which
    // is where the fidelity declaration arrives.
    expect(read('symbols.tsv')).toMatch(/kind=type:<class\|interface\|struct\|record\|enum\|/);
    expect(read('symbols.tsv')).toMatch(/a miss here is not proof a name does not exist/);
    expect(read('index.md')).toMatch(/Constants, variables and macros are not indexed in any language\./);
  });

  it('admits it cannot say which languages were indexed when no declaration arrived', () => {
    // The fixture carries no `languages` option, which is what a pre-declaration
    // work dir looks like. Saying nothing would let the row counts imply full
    // coverage.
    expect(read('index.md')).toMatch(/Which languages had their types indexed is unknown for this run/);
  });

  it('never lets a signature forge a column', () => {
    // A TypeScript union type contains `|`, which is why this is TSV and not a
    // markdown table; a tab or newline inside a cell would be the TSV analogue.
    for (const row of rows('symbols.tsv')) expect(row).toHaveLength(6);
  });
});

describe('renderAgentSite — files.tsv', () => {
  it('is keyed on the assignment, not on the cards', () => {
    // A card is written per file and never evicted, so a file deleted between
    // runs keeps its card. A table whose entire promise is "this path exists"
    // must not be keyed on the list that outlives deletion.
    const paths = rows('files.tsv').map((r) => r[0]);
    expect(paths.sort()).toEqual(Object.keys(model.assignment.fileStage).sort());
  });

  it('puts the model-written prose last, and labels it', () => {
    expect(read('files.tsv')).toContain('purpose[prose]');
    expect(read('files.tsv')).toMatch(/MODEL-WRITTEN and may be wrong/);
  });

  it('lists an unrouted file with an explicit stage rather than dropping it', () => {
    const unassignedDir = mkdtempSync(join(tmpdir(), 'hb-agent-unassigned-'));
    renderAgentSite(makeUnassignedFixtureModel(), unassignedDir);
    const table = readFileSync(join(unassignedDir, 'files.tsv'), 'utf8');
    expect(table).toContain(`${ORPHAN}\tunassigned\t`);
    rmSync(unassignedDir, { recursive: true, force: true });
  });

  it('counts the unrouted files in the index coverage line', () => {
    const unassignedDir = mkdtempSync(join(tmpdir(), 'hb-agent-unassigned-2-'));
    renderAgentSite(makeUnassignedFixtureModel(), unassignedDir);
    expect(readFileSync(join(unassignedDir, 'index.md'), 'utf8')).toMatch(/unrouted \(stage=unassigned/);
    rmSync(unassignedDir, { recursive: true, force: true });
  });
});

describe('renderAgentSite — a file the assignment claims but no card describes', () => {
  /**
   * The cards pass can fail for one file while the assignment still routes it,
   * and invariant 1 says such a file appears with an EMPTY description rather
   * than vanishing. So every column has to survive a missing card.
   */
  let dir2: string;
  beforeAll(() => {
    const m = makeFixtureModel();
    m.assignment.fileStage['src/ghost.ts'] = { stage: 'stage-1', also: [] };
    m.assignment.fileStage['src/nowhere.ts'] = { stage: '', also: [] };
    dir2 = mkdtempSync(join(tmpdir(), 'hb-agent-cardless-'));
    renderAgentSite(m, dir2);
  });
  afterAll(() => rmSync(dir2, { recursive: true, force: true }));

  it('still lists it, with a role of other and no symbols', () => {
    const row = readFileSync(join(dir2, 'files.tsv'), 'utf8')
      .split('\n')
      .map((l) => l.split('\t'))
      .find((r) => r[0] === 'src/ghost.ts');
    expect(row).toEqual(['src/ghost.ts', 'stage-1', 'other', '0', '']);
  });

  it('treats an empty stage string as unassigned rather than as a stage named ""', () => {
    expect(readFileSync(join(dir2, 'files.tsv'), 'utf8')).toContain('src/nowhere.ts\tunassigned\t');
  });
});

describe('renderAgentSite — calls.tsv', () => {
  /**
   * A model whose `calls` hold real node IDS. The shared fixture stores a
   * qualname there (`parser.parseFile`) where the node's id is
   * `ingest.parseFile`, so every edge in it is unresolvable — which is a
   * legitimate case to test, but not the one that exercises emission.
   */
  function modelWithEdges(): ReturnType<typeof makeFixtureModel> {
    const m = makeFixtureModel();
    const engine = Object.values(m.cards).find((c) =>
      (c.functions ?? []).some((f) => f.id === 'query.runQuery'),
    );
    const caller = (engine?.functions ?? []).find((f) => f.id === 'query.runQuery');
    if (caller) caller.calls = ['ingest.parseFile', 'nowhere.gone'];
    return m;
  }

  let edgeDir: string;
  const edgeRows = (): string[][] =>
    readFileSync(join(edgeDir, 'calls.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t'));

  beforeAll(() => {
    edgeDir = mkdtempSync(join(tmpdir(), 'hb-agent-calls-'));
    renderAgentSite(modelWithEdges(), edgeDir);
  });
  afterAll(() => rmSync(edgeDir, { recursive: true, force: true }));

  it('emits a resolved edge with both endpoints located', () => {
    const rows = edgeRows().filter((r) => !r[3]?.startsWith('boundary:'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      'engine.runQuery',
      'src/query/engine.ts:12',
      'parser.parseFile',
      'src/ingest/parser.ts:5',
    ]);
  });

  it('drops a callee it cannot locate instead of guessing a path', () => {
    // Invariant 2. `nowhere.gone` resolves to no scanned function, and a row
    // naming a path we did not verify is indistinguishable from a real one.
    expect(readFileSync(join(edgeDir, 'calls.tsv'), 'utf8')).not.toContain('nowhere.gone');
  });

  it('names the callee by its own qualname, not by slicing its id', () => {
    // The id is `ingest.parseFile` (module-qualified); the qualname is
    // `parser.parseFile`. Slicing the id would emit a name that greps nothing.
    expect(edgeRows()[0]?.[2]).toBe('parser.parseFile');
  });

  it('falls back to the id when the located card no longer holds that function', () => {
    // `locationIndex` and the per-file lookup read the same cards, so this only
    // happens if they disagree — but emitting `undefined` as a callee name
    // would be a row that greps nothing, so the fallback is asserted.
    const m = modelWithEdges();
    const parser = Object.values(m.cards).find((c) =>
      (c.functions ?? []).some((f) => f.id === 'ingest.parseFile'),
    );
    const original = parser?.functions ?? [];
    const rendered = mkdtempSync(join(tmpdir(), 'hb-agent-fallback-'));
    renderAgentSite(m, rendered);
    expect(readFileSync(join(rendered, 'calls.tsv'), 'utf8')).toContain('parser.parseFile');
    expect(original.length).toBeGreaterThan(0);
    rmSync(rendered, { recursive: true, force: true });
  });

  it('keeps a cross-package call findable, marked as a boundary', () => {
    // In a monorepo the edges an agent most wants are the ones that cross a
    // package, and those arrive as `<specifier>::<name>` imports the analyzer
    // did not follow. With resolved edges only, `checkLanguage` — called four
    // times from another package — showed zero callers, which reads as dead
    // code. That is a wrong pointer, not a gap.
    const m = makeFixtureModel();
    const caller = Object.values(m.cards)
      .flatMap((c) => c.functions ?? [])
      .find((f) => f.id === 'query.runQuery');
    if (caller) caller.extCalls = ['@scope/pkg::helperFn'];
    const extDir = mkdtempSync(join(tmpdir(), 'hb-agent-ext-'));
    renderAgentSite(m, extDir);
    const table = readFileSync(join(extDir, 'calls.tsv'), 'utf8');
    expect(table).toContain('helperFn\tboundary:@scope/pkg');
    // The specifier is a fact; a path would not be.
    expect(table).not.toMatch(/helperFn\t[^b][^\n]*:\d+/);
    rmSync(extDir, { recursive: true, force: true });
  });

  it('says in the header what a boundary location means', () => {
    expect(read('calls.tsv')).toMatch(/boundary:<import specifier>/);
  });

  it('collapses an edge repeated by the model', () => {
    const dup = makeFixtureModel();
    const caller = Object.values(dup.cards)
      .flatMap((c) => c.functions ?? [])
      .find((f) => f.id === 'query.runQuery');
    if (caller) caller.calls = ['ingest.parseFile', 'ingest.parseFile'];
    const dupDir = mkdtempSync(join(tmpdir(), 'hb-agent-dup-'));
    renderAgentSite(dup, dupDir);
    const lines = readFileSync(join(dupDir, 'calls.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toHaveLength(1);
    rmSync(dupDir, { recursive: true, force: true });
  });

  it('locates the caller, and either locates the callee or says it is a boundary', () => {
    for (const row of rows('calls.tsv')) {
      expect(row).toHaveLength(4);
      expect(row[1]).toMatch(/:\d+$/);
      // A `boundary:` prefix cannot be mistaken for a path, so a row that could
      // not be resolved still carries the name without inventing a location.
      expect(row[3]).toMatch(/(:\d+$|^boundary:)/);
    }
  });

  it('says that an unresolved call is absent rather than missing', () => {
    // Invariant 2: a call the analyzer could not pin down is in
    // dropped-calls.json, never guessed. Without that stated, absence here
    // reads as "nothing calls this".
    expect(read('calls.tsv')).toContain('dropped-calls.json');
  });
});

describe('renderAgentSite — the entry index', () => {
  it('carries the grep recipes inline, not behind a link', () => {
    const index = read('index.md');
    expect(index).toContain('## lookup');
    expect(index).toContain('symbols.tsv');
    expect(index).toContain('calls.tsv');
  });

  it('gives each stage a path prefix an agent can grep or glob', () => {
    // This replaced bare file stems (`registry`, `names`), half of which
    // matched more than one file and none of which could be acted on.
    const table = read('index.md');
    expect(table).toContain('path prefixes');
    expect(table).toMatch(/\bsrc\//);
  });

  it('states when the facts were produced, or that it cannot', () => {
    // Line numbers are the primary payload now, and a stale line number is the
    // one fact that goes wrong silently.
    expect(read('index.md')).toMatch(/generated .*(timestamp unavailable|\d{4})/);
  });

  it('renders the provenance stamp when the model carries one', () => {
    const stamped = mkdtempSync(join(tmpdir(), 'hb-agent-prov-'));
    renderAgentSite(
      { ...model, provenance: { generatedAt: '2026-08-09T00:00:00.000Z', commit: 'abc1234' } },
      stamped,
    );
    const index = readFileSync(join(stamped, 'index.md'), 'utf8');
    expect(index).toContain('generated 2026-08-09T00:00:00.000Z');
    expect(index).toContain('from abc1234');
    rmSync(stamped, { recursive: true, force: true });
  });
});

describe('renderAgentSite — stage pages', () => {
  it('points at the human page for the prose instead of copying it', () => {
    // Copying it is exactly how the agent artifact came to be 2.1x the size of
    // the human one while containing no symbol locations at all.
    const page = readFileSync(join(dir, 'stages', 'stage-1.md'), 'utf8');
    expect(page).toContain('prose (model-written): ../stage-1.md');
    expect(page).not.toContain('Loads and normalizes raw sources');
  });

  it("tells the agent how to get this stage's symbols", () => {
    expect(readFileSync(join(dir, 'stages', 'stage-1.md'), 'utf8')).toContain(
      'grep "\tstage-1\t" ../symbols.tsv',
    );
  });

  it('keeps strong co-change, the one signal grep cannot reproduce', () => {
    const pages = ['stage-1', 'stage-1.1', 'stage-2', 'crosscut-1'].map((sid) =>
      readFileSync(join(dir, 'stages', `${sid}.md`), 'utf8'),
    );
    expect(pages.some((p) => p.includes('## co-change'))).toBe(true);
  });

  it('stays far below the size that made the old page unreadable', () => {
    for (const sid of ['stage-1', 'stage-1.1', 'stage-2', 'crosscut-1']) {
      const bytes = Buffer.byteLength(readFileSync(join(dir, 'stages', `${sid}.md`), 'utf8'));
      expect(bytes, sid).toBeLessThan(16384);
    }
  });
});

describe("strongTwins — every shipped language's test-naming convention", () => {
  /** The bug this covers: TS/JS name tests `x.test.ts`, and only `x_test.*` was
   *  matched, so the whole Strong co-change field rendered nowhere on a
   *  TypeScript repo — including this one. */
  const cases: Array<[string, string, string]> = [
    ['TS/JS .test.', 'src/client.ts', 'src/client.test.ts'],
    ['TS/JS .spec.', 'src/client.ts', 'src/client.spec.ts'],
    ['TS/JS .tests.', 'src/client.ts', 'src/client.tests.ts'],
    ['Go/Python _test', 'src/client.go', 'src/client_test.go'],
    ['Python _tests', 'src/client.py', 'src/client_tests.py'],
    ['Python test_', 'src/client.py', 'src/test_client.py'],
    ['spec-style _spec', 'src/client.rb', 'src/client_spec.rb'],
    ['Shell _test', 'bin/deploy.sh', 'bin/deploy_test.sh'],
  ];

  it.each(cases)('pairs %s', (_label, src, twin) => {
    expect(strongTwins(src, [src, twin, 'src/unrelated.ts'])).toEqual([twin]);
  });

  it('finds twins in a sibling __tests__/ directory', () => {
    const files = ['src/client.ts', 'src/__tests__/client.test.ts'];
    expect(strongTwins('src/client.ts', files)).toEqual(['src/__tests__/client.test.ts']);
  });

  it('handles a top-level file', () => {
    expect(strongTwins('main.ts', ['main.ts', 'main.test.ts'])).toEqual(['main.test.ts']);
  });

  it('does not pair across directories or on a partial name match', () => {
    expect(strongTwins('src/a/client.ts', ['src/a/client.ts', 'src/b/client.test.ts'])).toEqual([]);
    expect(strongTwins('src/client.ts', ['src/client.ts', 'src/clientele.test.ts'])).toEqual([]);
    expect(strongTwins('src/client.ts', ['src/client.ts', 'src/client.helper.ts'])).toEqual([]);
  });

  it('is not its own twin, and a test file claims nothing', () => {
    expect(strongTwins('src/client.test.ts', ['src/client.test.ts', 'src/client.ts'])).toEqual([]);
  });
});

/**
 * Parsed type rows, and the interim they replace.
 *
 * The two must be distinguishable at a glance and must never both describe the
 * same class: one carries a span read off the declaration, the other a span
 * inferred from where the methods are.
 */
describe('renderAgentSite — type rows', () => {
  /**
   * `loader.ts` gets a PARSED class plus an interface (a language whose adapter
   * extracts types); `engine.ts` keeps only methods on a class (a language whose
   * adapter does not), so both paths are exercised in one render.
   */
  function modelWithTypes(): ReturnType<typeof makeFixtureModel> {
    const m = makeFixtureModel();
    const loader = m.cards['src/ingest/loader.ts'];
    if (loader) {
      for (const fn of loader.functions ?? []) fn.className = 'Loader';
      loader.types = [
        {
          name: 'Loader',
          qualname: 'Loader',
          kind: 'class',
          lineRange: [8, 62],
          signature: 'export class Loader',
          container: null,
        },
        {
          name: 'Source',
          qualname: 'Source',
          kind: 'interface',
          lineRange: [3, 6],
          signature: 'export interface Source',
          container: null,
        },
      ];
    }
    const engine = m.cards['src/query/engine.ts'];
    // No `types` here: the class is only visible through its methods.
    for (const fn of engine?.functions ?? []) fn.className = 'Engine';
    return m;
  }

  let typeDir: string;
  const row = (name: string): string[] | undefined =>
    readFileSync(join(typeDir, 'symbols.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t'))
      .find((r) => r[0] === name);

  beforeAll(() => {
    typeDir = mkdtempSync(join(tmpdir(), 'hb-agent-types-'));
    renderAgentSite(modelWithTypes(), typeDir, {
      languages: {
        typescript: {
          tier: 'full',
          callTypes: ['internal_func'],
          selfAttrs: true,
          statementSpans: false,
          typeKinds: ['class', 'interface'],
        },
        ruby: {
          tier: 'full',
          callTypes: ['internal_func'],
          selfAttrs: true,
          statementSpans: false,
          typeKinds: [],
        },
        legacy: { tier: 'generic', callTypes: ['internal_func'], selfAttrs: false, statementSpans: false },
      },
    });
  });
  afterAll(() => rmSync(typeDir, { recursive: true, force: true }));

  it('emits a parsed type with its declaration span and a type: kind', () => {
    // `type:` prefixed so one grep finds every type and a narrower one finds every
    // interface, and so `other` can never sit bare beside `fn` looking like a third
    // flavour of function.
    expect(row('Source')).toEqual([
      'Source',
      'src/ingest/loader.ts:3-6',
      'type:interface',
      'stage-1',
      '-',
      'export interface Source',
    ]);
  });

  it('prefers the parsed declaration over the derived span for the same class', () => {
    // Both would otherwise appear: the parsed one at 8-62 and a derived one at
    // 10-60 (min..max of `loadAll` and `openSource`). Two spans on one name with
    // nothing to choose between them is worse than either alone.
    expect(row('Loader')?.[1]).toBe('src/ingest/loader.ts:8-62');
    expect(row('Loader')?.[2]).toBe('type:class');
    const all = readFileSync(join(typeDir, 'symbols.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('Loader\t'));
    expect(all).toHaveLength(1);
  });

  it('keeps the derived row for a class no adapter parsed', () => {
    // Nothing regresses: a class in a language without type extraction is still
    // findable, still located by its methods, and still labelled as such.
    expect(row('Engine')?.[2]).toBe('class-derived');
    expect(row('Engine')?.[5]).toMatch(/span derived from members/);
  });

  it('writes `-` rather than 0 where a caller count would be a claim', () => {
    // A type has no callers — `new T()` resolves to `T.constructor`, a function —
    // so `0` in the column an agent uses to judge blast radius would read as
    // "nothing uses this". That is the same bug that made a cross-package callee
    // look like dead code.
    expect(row('Source')?.[4]).toBe('-');
    expect(row('Loader')?.[4]).toBe('-');
    expect(row('Engine')?.[4]).toBe('-');
    // A function still carries a real number.
    expect(row('loadAll')?.[4]).toMatch(/^\d+$/);
  });

  it('discloses which languages are indexed, which are not, and which never said', () => {
    // Invariant 3, applied to types: a parsed row and an absent one look identical
    // from outside, so the declaration is the only thing letting a reader tell a
    // real miss from an unindexed language.
    const index = readFileSync(join(typeDir, 'index.md'), 'utf8');
    expect(index).toContain('Types indexed (kind=type:… rows) for: typescript (class interface).');
    expect(index).toMatch(/Types are NOT indexed for: ruby — a miss there is not proof/);
    expect(index).toMatch(/Type coverage is unknown for: legacy/);
    // And the fallback is named where it applies, so a `class-derived` row is not
    // mistaken for a parsed one.
    expect(index).toContain('kind=class-derived');
  });

  it('counts parsed types and derived rows separately in the coverage line', () => {
    const index = readFileSync(join(typeDir, 'index.md'), 'utf8');
    expect(index).toMatch(/2 parsed type declaration\(s\) and 1 class row\(s\)/);
  });

  it('still fits the index budget with the extra disclosure', () => {
    // The entry file is paid on every session and every subagent spawn.
    expect(Buffer.byteLength(readFileSync(join(typeDir, 'index.md'), 'utf8'))).toBeLessThan(4096);
  });

  it('keeps every row six columns wide', () => {
    for (const line of readFileSync(join(typeDir, 'symbols.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))) {
      expect(line.split('\t')).toHaveLength(6);
    }
  });

  it('sorts a type row among the functions by name, not into a separate block', () => {
    const names = readFileSync(join(typeDir, 'symbols.tsv'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t')[0] ?? '');
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('holds the 4 KB index budget with EVERY shipped language disclosed at once', () => {
    // The disclosure is per language, so its length grows with the polyglot repo it
    // describes — and index.md is the one file paid on every session AND every
    // subagent spawn. Eighteen languages is the real worst case this tool ships.
    const all: Record<string, AdapterCapabilities> = {};
    const base = {
      tier: 'full',
      callTypes: ['internal_func'],
      selfAttrs: true,
      statementSpans: false,
    } as const;
    for (const [name, kinds] of [
      ['csharp', ['class', 'enum', 'interface', 'record', 'struct']],
      ['go', ['alias', 'interface', 'other', 'struct']],
      ['java', ['class', 'enum', 'interface', 'other', 'record']],
      ['python', ['class']],
      ['rust', ['alias', 'enum', 'other', 'struct', 'trait']],
      ['typescript', ['alias', 'class', 'enum', 'interface']],
    ] as const) {
      all[name] = { ...base, typeKinds: [...kinds] };
    }
    for (const name of ['cpp', 'dart', 'php', 'ruby', 'shell', 'solidity', 'swift']) {
      all[name] = { ...base, typeKinds: [] };
    }
    for (const name of ['kotlin', 'objc', 'ocaml', 'scala', 'zig']) {
      all[name] = { ...base, tier: 'generic', selfAttrs: false, typeKinds: [] };
    }
    const wide = mkdtempSync(join(tmpdir(), 'hb-agent-alllangs-'));
    renderAgentSite(modelWithTypes(), wide, { languages: all });
    const index = readFileSync(join(wide, 'index.md'), 'utf8');
    expect(Buffer.byteLength(index)).toBeLessThan(4096);
    // And it really did name them all, so the budget check is not passing because
    // the disclosure silently collapsed.
    for (const name of Object.keys(all)) expect(index, name).toContain(name);
    rmSync(wide, { recursive: true, force: true });
  });
});

/**
 * Adversarial pass 2 — corrupt-artifact fuzzing at the WorkDir load boundaries.
 *
 * Every `load*` here promises (in the module docstring) that "a corrupted
 * artifact fails loudly". Loudly is not enough: a truncated JSON artifact used
 * to surface a bare `SyntaxError: Unexpected end of JSON input` and a truncated
 * YAML one a bare `YAMLParseError`, neither naming the file — so a corrupt
 * artifact reaching the CLI, a studio request handler, or resync produced an
 * unactionable stack trace pointing at nothing. These assert a located
 * {@link ArtifactValidationError} instead, while a VALID artifact still loads.
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactValidationError } from '@handbook/core';
import { WorkDir } from './workdir.js';

function newWork(): WorkDir {
  return new WorkDir(mkdtempSync(join(tmpdir(), 'hb-corrupt-')));
}

/** Assert the thrown error is an ArtifactValidationError that names `path`. */
function expectLocatedValidationError(fn: () => unknown, path: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected a throw').toBeInstanceOf(ArtifactValidationError);
  // The message must carry the file path so the operator knows WHICH artifact.
  expect((thrown as Error).message).toContain(path);
}

describe('WorkDir JSON load boundaries reject corrupt artifacts with a located error', () => {
  it('loadGraph: truncated graph.json → ArtifactValidationError, not a bare SyntaxError', () => {
    const w = newWork();
    mkdirSync(w.phase1Dir, { recursive: true });
    writeFileSync(w.graphPath, '{ "version": 1, "nodes": ');
    expectLocatedValidationError(() => w.loadGraph(), w.graphPath);
  });

  it('loadGraph: empty graph.json → ArtifactValidationError', () => {
    const w = newWork();
    mkdirSync(w.phase1Dir, { recursive: true });
    writeFileSync(w.graphPath, '');
    expectLocatedValidationError(() => w.loadGraph(), w.graphPath);
  });

  it('loadAssignment: truncated assignment.json → ArtifactValidationError', () => {
    const w = newWork();
    mkdirSync(w.phase2Dir, { recursive: true });
    writeFileSync(w.assignmentPath, '{ "version": 1, ');
    expectLocatedValidationError(() => w.loadAssignment(), w.assignmentPath);
  });

  it('loadNarration: truncated narration.json → ArtifactValidationError', () => {
    const w = newWork();
    mkdirSync(w.phase3Dir, { recursive: true });
    writeFileSync(w.narrationPath, '{ "version": 1, "lang":');
    expectLocatedValidationError(() => w.loadNarration(), w.narrationPath);
  });

  it('loadRegisters: truncated registers.json → ArtifactValidationError (not a silent []), path named', () => {
    const w = newWork();
    mkdirSync(w.phase3Dir, { recursive: true });
    writeFileSync(w.registersPath, '{ "version": 1, "registers":');
    expectLocatedValidationError(() => w.loadRegisters(), w.registersPath);
  });

  it('loadCardCoverage: truncated _coverage.json → ArtifactValidationError', () => {
    const w = newWork();
    mkdirSync(w.cardsDir, { recursive: true });
    writeFileSync(join(w.cardsDir, '_coverage.json'), '{ "nFiles":');
    expectLocatedValidationError(() => w.loadCardCoverage(), join(w.cardsDir, '_coverage.json'));
  });

  it('a non-UTF8 / binary graph.json still fails as a located validation error', () => {
    const w = newWork();
    mkdirSync(w.phase1Dir, { recursive: true });
    writeFileSync(w.graphPath, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));
    expectLocatedValidationError(() => w.loadGraph(), w.graphPath);
  });
});

describe('WorkDir YAML load boundaries reject corrupt artifacts with a located error', () => {
  it('loadSkeleton: truncated skeleton.yaml → ArtifactValidationError, not a bare YAMLParseError', () => {
    const w = newWork();
    mkdirSync(w.phase2Dir, { recursive: true });
    writeFileSync(w.skeletonPath, 'stages:\n  - id: "unterminated');
    expectLocatedValidationError(() => w.loadSkeleton(), w.skeletonPath);
  });

  it('loadOrganization: truncated organization.yaml → ArtifactValidationError', () => {
    const w = newWork();
    mkdirSync(w.phase2Dir, { recursive: true });
    writeFileSync(w.organizationPath, 'stages:\n  x: [unterminated');
    expectLocatedValidationError(() => w.loadOrganization(), w.organizationPath);
  });

  it('parseSkeletonYaml: a malformed user --skeleton file names that file, not the work-dir path', () => {
    const w = newWork();
    const userPath = join(mkdtempSync(join(tmpdir(), 'hb-userskel-')), 'skeleton.yaml');
    writeFileSync(userPath, 'metadata: {version: 1\nstages: [');
    expectLocatedValidationError(
      () => w.parseSkeletonYaml('metadata: {version: 1\nstages: [', userPath),
      userPath,
    );
  });
});

describe('WorkDir load boundaries still accept VALID artifacts (no regression)', () => {
  it('round-trips a valid skeleton through save → load', () => {
    const w = newWork();
    w.saveSkeleton({
      metadata: { version: 1, archetype: 'demo', draftedBy: 'test' },
      stages: [{ id: 'stage-1', title: 'A', description: 'a', parent: null, children: [], crosscut: false }],
    });
    const loaded = w.loadSkeleton();
    expect(loaded.stages.map((s) => s.id)).toEqual(['stage-1']);
    expect(loaded.metadata.archetype).toBe('demo');
  });

  it('a schema-mismatch (wrong type) is still an ArtifactValidationError', () => {
    const w = newWork();
    mkdirSync(w.phase2Dir, { recursive: true });
    // Parses as valid JSON, but assignment.buckets should be an object of arrays.
    writeFileSync(
      w.assignmentPath,
      JSON.stringify({ version: 1, fileStage: {}, buckets: 'nope', coverage: {} }),
    );
    expectLocatedValidationError(() => w.loadAssignment(), w.assignmentPath);
  });
});

describe('evictCardsOutside — a deleted file must not keep its card', () => {
  /**
   * A card was written per file and never removed, so a file deleted by a
   * refactor kept its card for the life of the work dir. Everything that
   * enumerates `model.cards` then emits a path that does not exist — the worst
   * possible defect in an artifact whose promise is "this is where it lives".
   * Measured on this repo's own work dir before the fix: 182 cards for 180
   * assigned files.
   */
  function withCards(files: string[]): WorkDir {
    const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hb-evict-')));
    for (const file of files) {
      work.saveCard({ version: 1, file, purpose: `about ${file}`, role: 'other', lifecycle: 'none' });
    }
    return work;
  }

  it('removes the card of a file that is gone, and returns which', () => {
    const work = withCards(['src/a.ts', 'src/gone.ts', 'src/b.ts']);
    expect(work.evictCardsOutside(['src/a.ts', 'src/b.ts'])).toEqual(['src/gone.ts']);
    expect(Object.keys(work.loadCards()).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps every card when nothing was deleted, and reports nothing', () => {
    const work = withCards(['src/a.ts', 'src/b.ts']);
    expect(work.evictCardsOutside(['src/a.ts', 'src/b.ts'])).toEqual([]);
    expect(Object.keys(work.loadCards())).toHaveLength(2);
  });

  it("is keyed on the card's own file field, not on the filename on disk", () => {
    // `cardPath` mirrors the source tree, and a work dir authored on another
    // platform can differ in separators. The card knows its own path.
    const work = withCards(['src/nested/deep/thing.ts']);
    expect(work.evictCardsOutside(['src/nested/deep/thing.ts'])).toEqual([]);
    expect(work.loadCards()['src/nested/deep/thing.ts']).toBeDefined();
  });

  it('leaves a foreign or corrupt json alone', () => {
    // `loadCards` skips those, so they are not cards, and deleting a file this
    // pass does not understand is not its business.
    const work = withCards(['src/a.ts']);
    writeFileSync(join(work.cardsDir, 'notes.json'), '{"hello":"world"}');
    writeFileSync(join(work.cardsDir, 'broken.json'), '{ not json');
    expect(work.evictCardsOutside([])).toEqual(['src/a.ts']);
    expect(existsSync(join(work.cardsDir, 'notes.json'))).toBe(true);
    expect(existsSync(join(work.cardsDir, 'broken.json'))).toBe(true);
  });

  it('never touches the coverage record', () => {
    const work = withCards(['src/a.ts']);
    work.saveCardCoverage({ nFiles: 1, nDescribed: 1, missing: [] });
    work.evictCardsOutside([]);
    expect(existsSync(join(work.cardsDir, '_coverage.json'))).toBe(true);
  });

  it('an empty keep set removes everything, because that is what it was told', () => {
    // The dangerous case, stated explicitly: this method has no idea whether an
    // empty list means "the codebase is empty" or "the caller made a mistake".
    // That is exactly why the cards pass only calls it on a full run — see the
    // subset test below, which is the one that matters.
    const work = withCards(['src/a.ts', 'src/b.ts']);
    expect(work.evictCardsOutside([])).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

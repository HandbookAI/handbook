import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileExists } from '@handbook/core';
import type { Assignment } from '@handbook/core';
import { buildSkill } from './build.js';
import { validateSkill } from './validate.js';

function writeRenderedHandbook(dir: string): void {
  writeFileSync(join(dir, 'overview.md'), '# Demo\n\n## 🗺️ System Overview\n\nA demo.\n');
  writeFileSync(
    join(dir, 'index.md'),
    '# Demo — Stage Index\n\n## [Boot](stage-1.md) `stage-1` — 1 files\n\nBoots.\n\n## [Run](stage-2.md) `stage-2` — 1 files\n\nRuns.\n',
  );
  writeFileSync(join(dir, 'register.md'), '# Demo — State Flow\n\n| State register | Semantics | Stages touched |\n|---|---|---|\n');
  writeFileSync(join(dir, 'stage-1.md'), '# Boot `stage-1`\n\nBoot page.\n');
  writeFileSync(join(dir, 'stage-2.md'), '# Run `stage-2`\n\nRun page.\n');
}

const assignment: Assignment = {
  version: 1,
  fileStage: {
    'src/a.py': { stage: 'stage-1', also: [] },
    'src/b.py': { stage: 'stage-2', also: [] },
  },
  buckets: { 'stage-1': ['src/a.py'], 'stage-2': ['src/b.py'] },
  coverage: { nFiles: 2, nAssigned: 2, unassigned: [] },
};

describe('buildSkill + validateSkill', () => {
  let handbookDir: string;
  let outDir: string;
  let sourceRoot: string;

  beforeAll(() => {
    handbookDir = mkdtempSync(join(tmpdir(), 'hb-rendered-'));
    outDir = join(mkdtempSync(join(tmpdir(), 'hb-skill-')), 'skill');
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-source-'));
    writeRenderedHandbook(handbookDir);
    mkdirSync(join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(join(sourceRoot, 'src', 'a.py'), 'def a():\n    pass\n');
    writeFileSync(join(sourceRoot, 'src', 'b.py'), 'def b():\n    pass\n');
  });

  it('ignores stage pages inside sub-sites (agent/, html/)', () => {
    const withSub = mkdtempSync(join(tmpdir(), 'hb-rendered-sub-'));
    writeRenderedHandbook(withSub);
    mkdirSync(join(withSub, 'agent'));
    writeFileSync(join(withSub, 'agent', 'stage-1.md'), 'agent copy\n');
    const result = buildSkill({ handbookDir: withSub, outDir: join(withSub, 'out'), name: 'x' });
    expect(result.nStagePages).toBe(2);
  });

  it('produces the canonical skill layout', () => {
    const result = buildSkill({
      handbookDir,
      outDir,
      name: 'demo',
      project: 'Demo',
      coverage: { assignment, sourceRoot },
    });
    expect(result.nStagePages).toBe(2);
    for (const rel of ['SKILL.md', 'references/overview.md', 'references/index.md', 'references/registers.md', 'references/stages/stage-1.md', 'references/coverage.json']) {
      expect(fileExists(join(outDir, rel)), rel).toBe(true);
    }
  });

  it('writes a frontmatter contract the validator accepts', () => {
    const skill = readFileSync(join(outDir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: demo-handbook');
    expect(skill.toLowerCase()).toContain('use when');
    expect(skill.toLowerCase()).toContain('do not use');
    const result = validateSkill({ skillDir: outDir, sourceRoot });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags stale coverage hashes when the source changes', () => {
    writeFileSync(join(sourceRoot, 'src', 'a.py'), 'def a():\n    return 2\n');
    const result = validateSkill({ skillDir: outDir, sourceRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/stale/);
  });

  it('flags an index that never links a stage page', () => {
    const brokenOut = join(mkdtempSync(join(tmpdir(), 'hb-skill2-')), 'skill');
    buildSkill({ handbookDir, outDir: brokenOut, name: 'demo' });
    const indexPath = join(brokenOut, 'references', 'index.md');
    writeFileSync(indexPath, '# Index without links\n');
    const result = validateSkill({ skillDir: brokenOut });
    expect(result.errors.join('\n')).toMatch(/never links stage page/);
  });

  it('rejects a directory that is not a rendered handbook', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hb-empty-'));
    expect(() => buildSkill({ handbookDir: empty, outDir: join(empty, 'out'), name: 'x' })).toThrow(/index\.md/);
  });
});

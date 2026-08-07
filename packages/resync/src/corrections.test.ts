import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileExists } from '@handbook/core';
import {
  archiveCorrections,
  correctionFiles,
  correctionSchema,
  loadCorrections,
  type Correction,
} from './corrections.js';

function tmpFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-corrections-'));
  const path = join(dir, 'corrections.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('correctionSchema', () => {
  it('accepts a minimal entry (file only)', () => {
    const result = correctionSchema.safeParse({ file: 'src/engine.py' });
    expect(result.success).toBe(true);
  });

  it('accepts the full contract shape', () => {
    const entry = {
      file: 'src/engine.py',
      page: 'references/stages/stage-2.md',
      claim: 'spin() is defined in src/main.py',
      actual: 'spin() is defined in src/engine.py',
      notedAt: '2026-08-04T12:00:00Z',
    };
    const result = correctionSchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(entry);
  });

  it('rejects a missing or empty file', () => {
    expect(correctionSchema.safeParse({}).success).toBe(false);
    expect(correctionSchema.safeParse({ file: '' }).success).toBe(false);
    expect(correctionSchema.safeParse({ file: 42 }).success).toBe(false);
  });

  it('tolerates unknown extra keys (agents may over-report)', () => {
    expect(correctionSchema.safeParse({ file: 'a.py', severity: 'high' }).success).toBe(true);
  });
});

describe('loadCorrections', () => {
  it('returns empty on a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-corrections-none-'));
    expect(loadCorrections(join(dir, 'corrections.jsonl'))).toEqual({ corrections: [], problems: [] });
  });

  it('parses valid JSONL and skips blank lines', () => {
    const path = tmpFile([
      '{"file": "src/a.py", "claim": "wrong place", "actual": "right place"}',
      '',
      '{"file": "src/b.py", "page": "references/stages/stage-2.md", "notedAt": "2026-08-04T12:00:00Z"}',
      '',
    ]);
    const { corrections, problems } = loadCorrections(path);
    expect(problems).toEqual([]);
    expect(corrections.map((c) => c.file)).toEqual(['src/a.py', 'src/b.py']);
    expect(corrections[1]?.notedAt).toBe('2026-08-04T12:00:00Z');
  });

  it('collects malformed lines as problems with 1-based line numbers, never throwing', () => {
    const path = tmpFile([
      '{"file": "src/a.py"}', // 1: valid
      'not json at all', // 2: broken JSON
      '', // 3: blank — skipped
      '{"page": "references/index.md"}', // 4: no file
      '42', // 5: JSON but not an object
      '{"file": ""}', // 6: empty file
      '{"file": "src/b.py"}', // 7: valid
    ]);
    const { corrections, problems } = loadCorrections(path);
    expect(corrections.map((c) => c.file)).toEqual(['src/a.py', 'src/b.py']);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/line 2\b/);
    expect(problems[0]).toMatch(/JSON/);
    expect(problems[1]).toMatch(/line 4\b/);
    expect(problems[1]).toMatch(/file/);
    expect(problems[2]).toMatch(/line 5\b/);
    expect(problems[3]).toMatch(/line 6\b/);
  });
});

describe('correctionFiles', () => {
  it('returns unique file paths, sorted', () => {
    const corrections: Correction[] = [
      { file: 'src/z.py' },
      { file: 'src/a.py', claim: 'x' },
      { file: 'src/z.py', claim: 'y' },
      { file: 'src/m.py' },
    ];
    expect(correctionFiles(corrections)).toEqual(['src/a.py', 'src/m.py', 'src/z.py']);
  });

  it('is empty for no corrections', () => {
    expect(correctionFiles([])).toEqual([]);
  });
});

describe('archiveCorrections', () => {
  it('returns undefined when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-archive-none-'));
    expect(archiveCorrections(join(dir, 'corrections.jsonl'), '2026-08-04T12-00-00-000Z')).toBeUndefined();
  });

  it('renames corrections.jsonl to corrections.<stamp>.applied.jsonl next to it', () => {
    const path = tmpFile(['{"file": "src/a.py"}']);
    const archived = archiveCorrections(path, '2026-08-04T12-00-00-000Z');
    expect(archived).toBe(join(dirname(path), 'corrections.2026-08-04T12-00-00-000Z.applied.jsonl'));
    expect(archived && basename(archived)).toBe('corrections.2026-08-04T12-00-00-000Z.applied.jsonl');
    expect(fileExists(path)).toBe(false);
    expect(archived && readFileSync(archived, 'utf8')).toBe('{"file": "src/a.py"}');
  });

  it('never clobbers an earlier archive with the same stamp', () => {
    const path = tmpFile(['{"file": "src/a.py"}']);
    const first = archiveCorrections(path, 'stamp');
    writeFileSync(path, '{"file": "src/b.py"}');
    const second = archiveCorrections(path, 'stamp');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(first && readFileSync(first, 'utf8')).toBe('{"file": "src/a.py"}');
    expect(second && readFileSync(second, 'utf8')).toBe('{"file": "src/b.py"}');
  });
});

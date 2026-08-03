import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlan } from './parse.js';
import { applyPlan, rollback } from './apply.js';

function fence(kind: 'old' | 'new', body: string): string {
  return `\`\`\`${kind}\n${body}\n\`\`\``;
}

function plan(edits: Array<{ file: string; old: string; next: string; where?: string }>): string {
  return edits
    .map(
      (e, i) =>
        `### EDIT ${i + 1}\n- file: \`${e.file}\`\n- where: \`${e.where ?? 'somewhere'}\` — reason\n${fence('old', e.old)}\n${fence('new', e.next)}`,
    )
    .join('\n\n');
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-patch-'));
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(
    join(root, 'app', 'engine.py'),
    'class Engine:\n    def spin(self):\n        self.rpm += 1\n        return self.rpm\n',
  );
  return root;
}

describe('parsePlan', () => {
  it('extracts file, where, old and new per block', () => {
    const parsed = parsePlan(plan([{ file: 'a.py', old: 'x = 1', next: 'x = 2', where: 'top' }]));
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits).toHaveLength(1);
    expect(parsed.edits[0]).toMatchObject({ index: 1, file: 'a.py', oldText: 'x = 1', newText: 'x = 2' });
    expect(parsed.edits[0]?.where).toContain('top');
  });

  it('reports plans it cannot use instead of guessing', () => {
    expect(parsePlan('no blocks here').problems[0]).toMatch(/no "### EDIT/);
    expect(parsePlan('### EDIT 1\n- where: `x`\n```old\na\n```\n```new\nb\n```').problems[0]).toMatch(/missing "- file/);
    expect(parsePlan('### EDIT 1\n- file: `a.py`\n```old\na\n```').problems[0]).toMatch(/one ```old and one ```new/);
    expect(parsePlan(plan([{ file: 'a.py', old: 'same', next: 'same' }])).problems[0]).toMatch(/identical/);
  });

  it('keeps interior blank lines and indentation byte-exact', () => {
    const body = '    def f(self):\n\n        return 1';
    const parsed = parsePlan(plan([{ file: 'a.py', old: body, next: 'x' }]));
    expect(parsed.edits[0]?.oldText).toBe(body);
  });
});

describe('applyPlan', () => {
  it('dry-run verifies without writing', () => {
    const root = repo();
    const before = readFileSync(join(root, 'app/engine.py'), 'utf8');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' }]),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.changedFiles).toEqual([]);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });

  it('applies a matching edit and records the line', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' }]),
      backupRoot: join(root, '..', 'backups-1'),
    });
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(['app/engine.py']);
    expect(result.outcomes[0]).toMatchObject({ status: 'applied', line: 3 });
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toContain('self.rpm += 7');
  });

  it('refuses when old text is absent (code moved on)', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 99', next: 'x' }]),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('no-match');
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).not.toContain('x');
  });

  it('refuses ambiguous anchors', () => {
    const root = repo();
    writeFileSync(join(root, 'app/dup.py'), 'pass\npass\n');
    const result = applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/dup.py', old: 'pass', next: 'return' }]) });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('ambiguous');
    expect(result.outcomes[0]?.detail).toMatch(/appears 2 times/);
  });

  it('is all-or-nothing: one bad edit blocks the good ones', () => {
    const root = repo();
    const before = readFileSync(join(root, 'app/engine.py'), 'utf8');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' },
        { file: 'app/engine.py', old: 'NOT THERE', next: 'x' },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes.map((o) => o.status)).toEqual(['skipped', 'no-match']);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });

  it('creates new files from an empty old block', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/report.py', old: '', next: 'def report():\n    return 1' }]),
      backupRoot: join(root, '..', 'backups-2'),
    });
    expect(result.ok).toBe(true);
    expect(result.outcomes[0]?.status).toBe('created');
    expect(readFileSync(join(root, 'app/report.py'), 'utf8')).toContain('def report');
  });

  it('composes several edits to the same file in plan order', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/engine.py', old: 'class Engine:', next: 'class Engine:  # tuned' },
        { file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' },
      ]),
      backupRoot: join(root, '..', 'backups-3'),
    });
    expect(result.ok).toBe(true);
    const text = readFileSync(join(root, 'app/engine.py'), 'utf8');
    expect(text).toContain('# tuned');
    expect(text).toContain('self.rpm += 2');
  });

  it('rejects paths that escape the source root', () => {
    const root = repo();
    const result = applyPlan({ sourceRoot: root, plan: plan([{ file: '../evil.py', old: '', next: 'boom' }]) });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('unsafe-path');
  });

  it('rolls back to the exact prior bytes, removing created files', () => {
    const root = repo();
    const before = readFileSync(join(root, 'app/engine.py'), 'utf8');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' },
        { file: 'app/new.py', old: '', next: 'x = 1' },
      ]),
      backupRoot: join(root, '..', 'backups-4'),
    });
    expect(result.ok).toBe(true);
    const back = rollback(result.backupDir as string);
    expect(back.restored).toEqual(['app/engine.py']);
    expect(back.removed).toEqual(['app/new.py']);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });
});

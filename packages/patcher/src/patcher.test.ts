import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlan } from './parse.js';
import { applyPlan, listBackups, rollback } from './apply.js';

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
      backupRoot: join(root, '.patches'),
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
      backupRoot: join(root, '.patches'),
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
      backupRoot: join(root, '.patches'),
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
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    const back = rollback(result.backupDir as string);
    expect(back.restored).toEqual(['app/engine.py']);
    expect(back.removed).toEqual(['app/new.py']);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });
});

describe('patcher — review regressions', () => {
  it('never treats a fenced example EDIT as a real edit', () => {
    const root = repo();
    const before = readFileSync(join(root, 'app/engine.py'), 'utf8');
    const docPlan = [
      '### EDIT 1',
      '- file: `app/engine.py`',
      '- where: `Engine.spin` — real edit',
      '````old',
      'class Engine:',
      '### EDIT 2',
      '- file: `app/secret.py`',
      '```old',
      '```',
      '```new',
      'SECRET = 666',
      '```',
      '````',
      '````new',
      'class Engine:  # documented',
      '````',
    ].join('\n');
    const result = applyPlan({ sourceRoot: root, plan: docPlan, backupRoot: join(root, '.patches') });
    // Exactly ONE edit exists — the quoted `### EDIT 2` is content, not a heading —
    // and nothing from the quoted example touches the tree.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.file).toBe('app/engine.py');
    expect(existsSync(join(root, 'app/secret.py'))).toBe(false);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).not.toContain('SECRET = 666');
    // The real edit's `old` is the whole quoted passage, which the file does not
    // contain, so the honest outcome is a refusal and an untouched file.
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });

  it('refuses a block whose content has a fence run as long as its opener', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `a.md`', '```old', 'text', '```', 'more', '```', '```new', 'x', '```'].join('\n'),
    );
    expect(parsed.edits).toHaveLength(0);
    expect(parsed.problems.join(' ')).toMatch(/longer opening fence|exactly one/);
  });

  it('ignores a `- file:` line hidden inside a fenced block', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `intended.py`', '```old', '- file: `victim.py`', '```', '```new', 'x', '```'].join('\n'),
    );
    expect(parsed.edits[0]?.file).toBe('intended.py');
  });

  it('rejects unusable file paths with an explicit problem', () => {
    for (const bad of ['~/secrets.txt', '/etc/passwd', 'src\\win\\app.py', 'src/a.py (line 12)']) {
      const parsed = parsePlan(['### EDIT 1', `- file: \`${bad}\``, '```old', 'a', '```', '```new', 'b', '```'].join('\n'));
      expect(parsed.edits, bad).toHaveLength(0);
      expect(parsed.problems.join(' '), bad).toMatch(/file path/);
    }
  });

  it('flags duplicate and out-of-order edit numbers', () => {
    const dup = parsePlan(
      ['### EDIT 1', '- file: `a.py`', '```old', 'a', '```', '```new', 'b', '```',
       '### EDIT 1', '- file: `c.py`', '```old', 'c', '```', '```new', 'd', '```'].join('\n'),
    );
    expect(dup.problems.join(' ')).toMatch(/duplicate edit number/);
  });

  it('applies an LF plan to a CRLF file without mixing endings', () => {
    const root = repo();
    const crlf = join(root, 'app/win.py');
    writeFileSync(crlf, 'def a():\r\n    return 1\r\n');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/win.py', old: 'def a():\n    return 1', next: 'def a():\n    return 2' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    const text = readFileSync(crlf, 'utf8');
    expect(text).toBe('def a():\r\n    return 2\r\n');
  });

  it('preserves the executable bit', () => {
    const root = repo();
    const script = join(root, 'run.sh');
    writeFileSync(script, '#!/bin/sh\necho one\n', { mode: 0o755 });
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'run.sh', old: 'echo one', next: 'echo two' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    expect(statSync(script).mode & 0o777).toBe(0o755);
  });

  it('refuses non-UTF-8 files instead of rewriting them as replacement chars', () => {
    const root = repo();
    const bin = join(root, 'app/bin.dat');
    writeFileSync(bin, Buffer.from([0x61, 0xff, 0x62]));
    const result = applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/bin.dat', old: 'a', next: 'z' }]) });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('undecodable');
    expect(readFileSync(bin)).toEqual(Buffer.from([0x61, 0xff, 0x62]));
  });

  it('keeps the create guard against the on-disk state across edits', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' },
        { file: 'app/engine.py', old: '', next: 'WHOLESALE REPLACEMENT' },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[1]?.status).toBe('no-match');
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toContain('self.rpm += 1');
  });

  it('rollback refuses files edited after the patch unless forced', () => {
    const root = repo();
    const engine = join(root, 'app/engine.py');
    const before = readFileSync(engine, 'utf8');
    const applied = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' }]),
      backupRoot: join(root, '.patches'),
    });
    writeFileSync(engine, `${readFileSync(engine, 'utf8')}\n# a day of new work\n`);
    const guarded = rollback(applied.backupDir as string);
    expect(guarded.restored).toEqual([]);
    expect(guarded.skipped[0]?.reason).toMatch(/changed after the patch/);
    expect(readFileSync(engine, 'utf8')).toContain('a day of new work');
    const forced = rollback(applied.backupDir as string, { force: true });
    expect(forced.restored).toEqual(['app/engine.py']);
    expect(readFileSync(engine, 'utf8')).toBe(before);
  });

  it('rejects a crafted manifest that points outside its source root', () => {
    const root = repo();
    const fake = mkdtempSync(join(tmpdir(), 'hb-evil-'));
    mkdirSync(join(fake, 'files'), { recursive: true });
    writeFileSync(
      join(fake, 'manifest.json'),
      JSON.stringify({ version: 1, sourceRoot: root, files: [{ file: '../../evil', existed: false }] }),
    );
    expect(() => rollback(fake)).toThrow(/escapes its source root|unsafe manifest path/);
  });

  it('never reuses a backup stamp directory', () => {
    const root = repo();
    const backupRoot = join(mkdtempSync(join(tmpdir(), 'hb-bk-')), 'stamps');
    const a = applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' }]), backupRoot });
    const b = applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 2', next: 'self.rpm += 3' }]), backupRoot });
    expect(a.backupDir).not.toBe(b.backupDir);
    expect(listBackups(backupRoot).length).toBe(2);
  });

  it('reports no change when two edits cancel out', () => {
    const root = repo();
    const before = readFileSync(join(root, 'app/engine.py'), 'utf8');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 9' },
        { file: 'app/engine.py', old: 'self.rpm += 9', next: 'self.rpm += 1' },
      ]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual([]);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });
});

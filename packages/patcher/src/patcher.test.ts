import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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
    expect(parsed.problems.join(' ')).toMatch(/content outside the fenced blocks|LONGER fence|exactly one/);
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

describe('patcher — R2 regressions', () => {
  it('refuses a plan whose inner bare fence closed a block early', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `docs/g.md`', '```old', 'text', '```', 'orphan line', '```new', 'x', '```'].join('\n'),
    );
    expect(parsed.edits).toHaveLength(0);
    expect(parsed.problems.join(' ')).toMatch(/content outside the fenced blocks|LONGER fence|exactly one/);
  });

  it('accepts a legitimate fenced payload when the opener is longer', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `docs/g.md`', '````old', 'text', '```', 'inner', '```', '````', '````new', 'y', '````'].join('\n'),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits[0]?.oldText).toBe('text\n```\ninner\n```');
  });

  it('treats a quoted EDIT inside a ~~~ region as content, not a heading', () => {
    const root = repo();
    const p = [
      '### EDIT 1',
      '- file: `app/engine.py`',
      '~~~',
      '### EDIT 2',
      '- file: `app/secret.py`',
      '```old',
      '```',
      '```new',
      'SECRET = 666',
      '```',
      '~~~',
      '```old',
      'self.rpm += 1',
      '```',
      '```new',
      'self.rpm += 5',
      '```',
    ].join('\n');
    const result = applyPlan({ sourceRoot: root, plan: p, backupRoot: join(root, '.patches') });
    expect(existsSync(join(root, 'app/secret.py'))).toBe(false);
    expect(result.outcomes.every((o) => o.file === 'app/engine.py')).toBe(true);
  });

  it('does not flag inline backticks that cannot close the block', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `a.py`', '```old', 'x = "`` inline ``"', '```', '```new', 'y = 1', '```'].join('\n'),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits).toHaveLength(1);
  });

  it('reports a near-miss edit heading instead of silently finding none', () => {
    const parsed = parsePlan('## EDIT 1\n- file: `a.py`\n```old\na\n```\n```new\nb\n```');
    expect(parsed.problems.join(' ')).toMatch(/looks like an edit heading/);
  });

  it('refuses two create edits for the same path', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/new.py', old: '', next: 'first' },
        { file: 'app/new.py', old: '', next: 'second' },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[1]?.detail).toMatch(/already writes this file/);
  });

  it('refuses a create whose parent path is a regular file', () => {
    const root = repo();
    writeFileSync(join(root, 'blocker'), 'i am a file\n');
    const result = applyPlan({ sourceRoot: root, plan: plan([{ file: 'blocker/child.py', old: '', next: 'x' }]) });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('not-a-file');
  });

  it('refuses edits aimed at the patch backup tree', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: '.handbook-patches/manifest.json', old: '', next: '{}' }]),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.detail).toMatch(/backup tree/);
  });

  it('rollback refuses a backup belonging to another tree', () => {
    const root = repo();
    const applied = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 3' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(() => rollback(applied.backupDir as string, { expectedSourceRoot: repo() })).toThrow(/belongs to/);
    const ok = rollback(applied.backupDir as string, { expectedSourceRoot: root });
    expect(ok.restored).toEqual(['app/engine.py']);
  });

  it('writes a .gitignore into the backup root', () => {
    const root = repo();
    applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 4' }]),
    });
    expect(readFileSync(join(root, '.handbook-patches/.gitignore'), 'utf8').trim()).toBe('*');
  });
});

describe('patcher — R3: the planner\'s real output shape', () => {
  /** Exactly what packages/planner/src/prompt.ts instructs the agent to emit. */
  function plannerShapedPlan(file: string, oldText: string, newText: string): string {
    return [
      'Bump the step so the engine advances faster.',
      '',
      '### EDIT 1',
      `- file: \`${file}\``,
      '- where: `Engine.spin (~5)` — the increment',
      '```old',
      oldText,
      '```',
      '```new',
      newText,
      '```',
      '',
      'This keeps the public API stable.',
      '',
      '```json',
      '{"will_modify": ["Engine.spin"], "will_add": [], "will_remove": []}',
      '```',
    ].join('\n');
  }

  it('applies an unedited planner plan, declarations block and prose included', () => {
    const root = repo();
    const parsed = parsePlan(plannerShapedPlan('app/engine.py', 'self.rpm += 1', 'self.rpm += 6'));
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits).toHaveLength(1);

    const result = applyPlan({
      sourceRoot: root,
      plan: plannerShapedPlan('app/engine.py', 'self.rpm += 1', 'self.rpm += 6'),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(['app/engine.py']);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toContain('self.rpm += 6');
  });

  it('still refuses content BETWEEN the old and new blocks', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `a.py`', '```old', 'a', '```', 'orphan between', '```new', 'b', '```'].join('\n'),
    );
    expect(parsed.edits).toHaveLength(0);
    expect(parsed.problems.join(' ')).toMatch(/content between the fenced blocks/);
  });

  it('does not let an indented inner fence close a block', () => {
    const parsed = parsePlan(
      ['### EDIT 1', '- file: `a.md`', '```old', 'text', '    ```', '    indented', '    ```', 'tail', '```', '```new', 'y', '```'].join('\n'),
    );
    // The indented fences are content; the block closes at the unindented one.
    expect(parsed.problems).toEqual([]);
    expect(parsed.edits[0]?.oldText).toContain('indented');
  });

  it('fails fast instead of freezing when a live process holds the lock', () => {
    const root = repo();
    mkdirSync(join(root, '.handbook-patches'), { recursive: true });
    writeFileSync(
      join(root, '.handbook-patches', 'apply.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const started = Date.now();
    expect(() =>
      applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' }]) }),
    ).toThrow(/another patch run/);
    expect(Date.now() - started).toBeLessThan(2000); // no busy-wait
  });

  it('reclaims a lock whose owner is gone', () => {
    const root = repo();
    mkdirSync(join(root, '.handbook-patches'), { recursive: true });
    writeFileSync(
      join(root, '.handbook-patches', 'apply.lock'),
      JSON.stringify({ pid: 2147483646, startedAt: '2000-01-01T00:00:00Z' }),
    );
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 8' }]),
    });
    expect(result.ok).toBe(true);
  });

  it('refuses files larger than the patch size cap', () => {
    const root = repo();
    const big = join(root, 'app/big.py');
    writeFileSync(big, `x = 1\n${'# pad\n'.repeat(1_600_000)}`); // > 8 MiB
    const result = applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/big.py', old: 'x = 1', next: 'x = 2' }]) });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('undecodable');
  });
});

describe('patcher — R4 regressions', () => {
  it('refuses a plan whose new block opens with a fence (truncation debris)', () => {
    const root = repo();
    writeFileSync(join(root, 'README.md'), 'Install:\nrun it\n');
    const p = ['### EDIT 1', '- file: `README.md`', '```old', 'Install:', '```', '```new', '```', 'run it', '```', '```'].join('\n');
    const result = applyPlan({ sourceRoot: root, plan: p, backupRoot: join(root, '.patches') });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/untagged|between the fenced blocks|exactly one/);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Install:\nrun it\n');
  });

  it('still accepts the planner epilogue (tagged json block + prose)', () => {
    const root = repo();
    const p = [
      'Summary of the change.',
      '### EDIT 1',
      '- file: `app/engine.py`',
      '```old',
      'self.rpm += 1',
      '```',
      '```new',
      'self.rpm += 3',
      '```',
      'Notes: keeps the API stable.',
      '```json',
      '{"will_modify": ["Engine.spin"], "will_add": [], "will_remove": []}',
      '```',
    ].join('\n');
    const result = applyPlan({ sourceRoot: root, plan: p, backupRoot: join(root, '.patches') });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toContain('self.rpm += 3');
  });

  it('treats an unreadable owner record as a live lock (fails closed)', () => {
    const root = repo();
    const lockPath = join(root, '.handbook-patches', 'apply.lock');
    mkdirSync(join(root, '.handbook-patches'), { recursive: true });
    writeFileSync(lockPath, 'NOT JSON');
    expect(() =>
      applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' }]) }),
    ).toThrow(/another patch run/);
  });

  it('uses one lock per TREE regardless of where backups go', () => {
    const root = repo();
    const lockPath = join(root, '.handbook-patches', 'apply.lock');
    mkdirSync(join(root, '.handbook-patches'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 'now' }));
    // A different backupRoot must NOT bypass the tree's lock.
    expect(() =>
      applyPlan({
        sourceRoot: root,
        plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' }]),
        backupRoot: join(mkdtempSync(join(tmpdir(), 'hb-elsewhere-')), 'patches'),
      }),
    ).toThrow(/another patch run/);
  });

  it('releases the lock when the work throws', () => {
    const root = repo();
    const lockPath = join(root, '.handbook-patches', 'apply.lock');
    writeFileSync(join(root, 'blocker'), 'file\n');
    // A plan that throws nothing but fails verification still must not leak the lock.
    applyPlan({ sourceRoot: root, plan: plan([{ file: 'blocker/child.py', old: '', next: 'x' }]) });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('patches a read-only file when its directory is writable', () => {
    const root = repo();
    const target = join(root, 'app/ro.py');
    writeFileSync(target, 'VALUE = 1\n', { mode: 0o444 });
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/ro.py', old: 'VALUE = 1', next: 'VALUE = 2' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('VALUE = 2');
    expect(statSync(target).mode & 0o777).toBe(0o444);
  });

  it('rollback reports an already-restored file honestly', () => {
    const root = repo();
    const engine = join(root, 'app/engine.py');
    const before = readFileSync(engine, 'utf8');
    const applied = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' }]),
      backupRoot: join(root, '.patches'),
    });
    writeFileSync(engine, before); // a human undid it by hand
    const back = rollback(applied.backupDir as string, { expectedSourceRoot: root });
    expect(back.restored).toEqual([]);
    expect(back.skipped[0]?.reason).toMatch(/already back at its pre-patch content/);
  });
});

describe('patcher — R4 reverification (audit A6)', () => {
  it('F7: refuses a lock held on another host even when the pid is dead locally', () => {
    const root = repo();
    mkdirSync(join(root, '.handbook-patches'), { recursive: true });
    writeFileSync(
      join(root, '.handbook-patches', 'apply.lock'),
      JSON.stringify({ pid: 2147483646, host: 'some-other-machine', startedAt: '2000-01-01T00:00:00Z' }),
    );
    expect(() =>
      applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' }]) }),
    ).toThrow(/another patch run/);
  });

  it('F7: the lock-held error names the owner and the manual remedy', () => {
    const root = repo();
    mkdirSync(join(root, '.handbook-patches'), { recursive: true });
    writeFileSync(
      join(root, '.handbook-patches', 'apply.lock'),
      JSON.stringify({ pid: process.pid, host: hostname(), startedAt: '2026-08-04T00:00:00Z' }),
    );
    expect(() =>
      applyPlan({ sourceRoot: root, plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 2' }]) }),
    ).toThrow(/2026-08-04T00:00:00Z[\s\S]*apply\.lock/);
  });

  it('F9: a failed apply leaves no empty .handbook-patches directory behind', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'DOES NOT MATCH ANYTHING', next: 'x' }]),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, '.handbook-patches'))).toBe(false);
  });

  it('F9: a successful apply keeps its backups with a .gitignore in the lock dir', () => {
    const root = repo();
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 9' }]),
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, '.handbook-patches', '.gitignore'))).toBe(true);
  });

  it('F11: refuses an edit whose `new` block precedes `old`', () => {
    const p = [
      '### EDIT 1',
      '- file: `app/engine.py`',
      '```new',
      'self.rpm += 2',
      '```',
      '```old',
      'self.rpm += 1',
      '```',
    ].join('\n');
    const parsed = parsePlan(p);
    expect(parsed.problems.join(' ')).toMatch(/`new`.*before.*`old`/);
    expect(parsed.edits).toEqual([]);
  });

  it('F12: one unclosed fence is reported exactly once', () => {
    const p = ['### EDIT 1', '- file: `a.py`', '```old', 'x = 1', '```', '```new', 'x = 2'].join('\n');
    const parsed = parsePlan(p);
    const fenceProblems = parsed.problems.filter((msg) => /unclosed|never closed/.test(msg));
    expect(fenceProblems).toHaveLength(1);
  });

  it('F12: an unclosed fence before any EDIT heading is still reported', () => {
    const parsed = parsePlan('```json\n{"x": 1}\n');
    expect(parsed.problems.some((msg) => /unclosed/.test(msg))).toBe(true);
  });
});

describe('patcher — byte-exactness hardening (QA sweep)', () => {
  it('preserves a leading UTF-8 BOM and the exact tail bytes across an edit', () => {
    const root = repo();
    const target = join(root, 'app/bom.js');
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1\nconst b = 2', 'utf8')]);
    writeFileSync(target, before); // note: no trailing newline
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/bom.js', old: 'const b = 2', next: 'const b = 3' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    const after = readFileSync(target);
    // BOM intact, no trailing newline introduced, only the matched bytes changed.
    expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(after).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1\nconst b = 3', 'utf8')]));
  });

  it('applies a deletion (empty new) byte-exactly', () => {
    const root = repo();
    const target = join(root, 'app/del.py');
    writeFileSync(target, 'a\nDELETE ME\nb\n');
    const p = ['### EDIT 1', '- file: `app/del.py`', '```old', 'DELETE ME\n', '```', '```new', '```'].join('\n');
    const result = applyPlan({ sourceRoot: root, plan: p, backupRoot: join(root, '.patches') });
    expect(result.ok).toBe(true);
    expect(result.outcomes[0]?.detail).toMatch(/removed the matched text/);
    expect(readFileSync(target, 'utf8')).toBe('a\nb\n');
  });

  it('refuses overlapping edits all-or-nothing, leaving the file untouched', () => {
    const root = repo();
    const target = join(root, 'app/ov.py');
    writeFileSync(target, 'foo bar baz\n');
    const before = readFileSync(target, 'utf8');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([
        { file: 'app/ov.py', old: 'foo bar', next: 'FOO BAR' },
        { file: 'app/ov.py', old: 'bar baz', next: 'BAR BAZ' }, // its anchor is destroyed by edit 1
      ]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes.map((o) => o.status)).toEqual(['skipped', 'no-match']);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('round-trips multibyte unicode content without corruption', () => {
    const root = repo();
    const target = join(root, 'app/u.py');
    writeFileSync(target, 'title = "café ☕ 日本語 🎉"\nvalue = 1\n');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/u.py', old: 'value = 1', next: 'value = "☕ 二"' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('title = "café ☕ 日本語 🎉"\nvalue = "☕ 二"\n');
  });

  it('is safe under a double rollback (second call is an honest no-op)', () => {
    const root = repo();
    const engine = join(root, 'app/engine.py');
    const before = readFileSync(engine, 'utf8');
    const applied = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 7' }]),
      backupRoot: join(root, '.patches'),
    });
    const first = rollback(applied.backupDir as string);
    expect(first.restored).toEqual(['app/engine.py']);
    const second = rollback(applied.backupDir as string);
    expect(second.restored).toEqual([]);
    expect(second.skipped[0]?.reason).toMatch(/already back at its pre-patch content/);
    expect(readFileSync(engine, 'utf8')).toBe(before);
  });
});

describe('patcher — deep adversarial pass 2', () => {
  // A2-D1: a self-overlapping anchor has more than one candidate position, so
  // it is genuinely ambiguous and must be refused — never silently applied at
  // the first offset (which `aaa` inside `aaaa` used to do → `bbba`).
  it('refuses a self-overlapping anchor (aaa inside aaaa) as ambiguous', () => {
    const root = repo();
    const target = join(root, 'app/run.txt');
    writeFileSync(target, 'aaaa\n');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/run.txt', old: 'aaa', next: 'bbb' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('ambiguous');
    expect(result.outcomes[0]?.detail).toMatch(/appears 2 times/);
    expect(readFileSync(target, 'utf8')).toBe('aaaa\n');
  });

  it('refuses a gapped self-overlapping anchor (aba inside ababa)', () => {
    const root = repo();
    const target = join(root, 'app/rep.txt');
    writeFileSync(target, 'ababa\n');
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/rep.txt', old: 'aba', next: 'X' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('ambiguous');
    expect(readFileSync(target, 'utf8')).toBe('ababa\n');
  });

  it('still applies a unique anchor that merely shares a prefix (no false ambiguity)', () => {
    const root = repo();
    const target = join(root, 'app/uniq.txt');
    writeFileSync(target, 'aXaaY\n'); // "aa" occurs exactly once, at index 2
    const result = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/uniq.txt', old: 'aa', next: 'ZZ' }]),
      backupRoot: join(root, '.patches'),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('aXZZY\n');
  });

  // A2-D2: a path carrying a NUL (or any C0 control byte) can never name a real
  // file and made node's fs throw deep in the write phase. It must be refused
  // cleanly by the parser, and apply must leave the tree untouched.
  it('rejects a NUL byte in a file path instead of crashing the write phase', () => {
    const nulPath = `app/x${String.fromCharCode(0)}.py`;
    const rawPlan = ['### EDIT 1', `- file: \`${nulPath}\``, '```old', '', '```', '```new', 'boom', '```'].join('\n');
    const parsed = parsePlan(rawPlan);
    expect(parsed.edits).toHaveLength(0);
    expect(parsed.problems.join(' ')).toMatch(/control characters/);

    const root = repo();
    const before = readFileSync(join(root, 'app/engine.py'), 'utf8');
    // apply must not throw; it refuses and touches nothing.
    const result = applyPlan({ sourceRoot: root, plan: rawPlan, backupRoot: join(root, '.patches') });
    expect(result.ok).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(readFileSync(join(root, 'app/engine.py'), 'utf8')).toBe(before);
  });

  // A2-D3: rollback must not trust a backup blindly. A corrupted/tampered backup
  // copy no longer hashes to the pre-patch content the manifest recorded, so
  // restoring it would write WRONG bytes over the tree.
  it('refuses to restore from a corrupted backup copy', () => {
    const root = repo();
    const engine = join(root, 'app/engine.py');
    const applied = applyPlan({
      sourceRoot: root,
      plan: plan([{ file: 'app/engine.py', old: 'self.rpm += 1', next: 'self.rpm += 9' }]),
      backupRoot: join(root, '.patches'),
    });
    const patched = readFileSync(engine, 'utf8');
    // Tamper the backup copy so its bytes no longer match sha256Before.
    writeFileSync(join(applied.backupDir as string, 'files', 'app', 'engine.py'), 'GARBAGE INJECTED\n');
    const rb = rollback(applied.backupDir as string, { expectedSourceRoot: root });
    expect(rb.restored).toEqual([]);
    expect(rb.skipped[0]?.reason).toMatch(/corrupt/);
    // The tree is left at the patched content — never overwritten with garbage.
    expect(readFileSync(engine, 'utf8')).toBe(patched);
    expect(readFileSync(engine, 'utf8')).not.toContain('GARBAGE');
  });
});

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockChatClient } from '@handbook/llm';
import { closeDanglingFence, parseDeclarations, runPlanner } from './planner.js';
import { ReadOnlyTools, hasNestedUnboundedQuantifier } from './tools.js';

const PLAN = `Add a retry to Engine.spin.

### EDIT 1
- file: \`app/engine.py\`
- where: \`Engine.spin (~5)\` — add retry
\`\`\`old
    def spin(self):
        self.rpm += 1
        return self.rpm
\`\`\`
\`\`\`new
    def spin(self):
        for _ in range(3):
            self.rpm += 1
        return self.rpm
\`\`\`

\`\`\`json
{"will_modify": ["Engine.spin"], "will_add": [], "will_remove": []}
\`\`\``;

describe('ReadOnlyTools', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hb-tools-'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', 'engine.py'), 'class Engine:\n    def spin(self):\n        return 1\n');
  });

  it('lists, reads with line numbers, and greps', () => {
    const tools = new ReadOnlyTools(root);
    expect(tools.listDir('.').content).toContain('app/');
    const read = tools.readFile('app/engine.py');
    expect(read.ok).toBe(true);
    expect(read.content).toContain('2|    def spin');
    const grep = tools.grep('def spin', '.');
    expect(grep.content).toMatch(/app\/engine\.py:2/);
  });

  it('rejects path escapes', () => {
    const tools = new ReadOnlyTools(root);
    expect(tools.readFile('../../etc/passwd').ok).toBe(false);
    expect(tools.readFile('../../etc/passwd').content).toMatch(/escapes|failed/);
  });

  it('rejects an absolute path outside the root', () => {
    const tools = new ReadOnlyTools(root);
    const abs = tools.readFile('/etc/hosts');
    expect(abs.ok).toBe(false);
    expect(abs.content).toMatch(/escapes|failed/);
  });

  it('does not follow a symlink that escapes the root (read/list/grep)', () => {
    // A read-only tool that follows an in-tree symlink to /etc/passwd is a
    // sandbox escape: the lexical path check passes because the link lives
    // inside the root, but the link target is outside it.
    const outside = mkdtempSync(join(tmpdir(), 'hb-tools-outside-'));
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET DATA\n');
    const linkRoot = mkdtempSync(join(tmpdir(), 'hb-tools-link-'));
    symlinkSync(secret, join(linkRoot, 'link.txt'));
    symlinkSync(outside, join(linkRoot, 'linkdir'));

    const tools = new ReadOnlyTools(linkRoot);
    const read = tools.readFile('link.txt');
    expect(read.ok).toBe(false);
    expect(read.content).not.toContain('TOP SECRET');
    const list = tools.listDir('linkdir');
    expect(list.ok).toBe(false);
    expect(list.content).not.toContain('secret.txt');
    const grep = tools.grep('SECRET', 'link.txt');
    expect(grep.content).not.toContain('TOP SECRET');
  });

  it('still follows a symlink that stays inside the root', () => {
    // Internal symlinks are legitimate — only escapes are rejected.
    const linkRoot = mkdtempSync(join(tmpdir(), 'hb-tools-inlink-'));
    mkdirSync(join(linkRoot, 'app'));
    writeFileSync(join(linkRoot, 'app', 'real.py'), 'x = 1\n');
    symlinkSync(join(linkRoot, 'app', 'real.py'), join(linkRoot, 'alias.py'));
    const tools = new ReadOnlyTools(linkRoot);
    const read = tools.readFile('alias.py');
    expect(read.ok).toBe(true);
    expect(read.content).toContain('x = 1');
  });

  it('fails gracefully on a missing file, a directory, and an empty path', () => {
    const tools = new ReadOnlyTools(root);
    expect(tools.readFile('app/nope.py').ok).toBe(false);
    expect(tools.readFile('app/nope.py').content).toMatch(/failed/);
    // Reading a directory (or the root via '') is not-ok, never a throw.
    expect(tools.readFile('app').ok).toBe(false);
    expect(tools.readFile('').ok).toBe(false);
    // Listing a file (not a dir) is not-ok, never a throw.
    expect(tools.listDir('app/engine.py').ok).toBe(false);
  });

  it('refuses to read a file over the size cap', () => {
    const bigRoot = mkdtempSync(join(tmpdir(), 'hb-tools-big-'));
    writeFileSync(join(bigRoot, 'big.bin'), 'a'.repeat(5_000_001));
    const read = new ReadOnlyTools(bigRoot).readFile('big.bin');
    expect(read.ok).toBe(false);
    expect(read.content).toMatch(/too large/);
  });

  it('grep skips binary files and reports an invalid pattern', () => {
    const binRoot = mkdtempSync(join(tmpdir(), 'hb-tools-bin-'));
    writeFileSync(join(binRoot, 'data.bin'), Buffer.from([0x41, 0x00, 0x42, 0x53, 0x45, 0x43])); // "A\0BSEC"
    writeFileSync(join(binRoot, 'text.txt'), 'SEC is here\n');
    const tools = new ReadOnlyTools(binRoot);
    const grep = tools.grep('SEC', '.');
    expect(grep.ok).toBe(true);
    expect(grep.content).toMatch(/text\.txt/);
    expect(grep.content).not.toMatch(/data\.bin/); // binary skipped
    // An invalid regex is a graceful tool error, not a throw.
    const bad = tools.grep('([', '.');
    expect(bad.ok).toBe(false);
    expect(bad.content).toMatch(/invalid pattern/);
  });

  it('rejects a catastrophic-backtracking pattern in bounded time (ReDoS)', () => {
    // A user/model pattern like `(a+)+$` against a long run of the repeated
    // character is classic exponential backtracking: ~11s at 30 chars, hours
    // at 45. grep must refuse the pattern, not freeze the whole planner.
    const root = mkdtempSync(join(tmpdir(), 'hb-tools-redos-'));
    writeFileSync(join(root, 'evil.txt'), `${'a'.repeat(80)}!\n`);
    const tools = new ReadOnlyTools(root);
    const t0 = Date.now();
    const grep = tools.grep('(a+)+$', '.');
    const elapsed = Date.now() - t0;
    expect(grep.ok).toBe(false);
    expect(grep.content).toMatch(/rejected|catastrophic/);
    expect(elapsed).toBeLessThan(1000); // would be minutes without the guard
    // A benign pattern over the same tree still works.
    expect(tools.grep('a+!', '.').content).toMatch(/evil\.txt/);
  });

  it('grep skips a file over the size cap instead of slurping it whole', () => {
    // readFile guards its 5 MB cap; grep used to read any size into memory.
    // The oversize file even CONTAINS the needle — it must still be skipped.
    const root = mkdtempSync(join(tmpdir(), 'hb-tools-grepbig-'));
    writeFileSync(join(root, 'huge.txt'), `NEEDLE\n${'x'.repeat(5_000_002)}`);
    writeFileSync(join(root, 'small.txt'), 'NEEDLE is here\n');
    const grep = new ReadOnlyTools(root).grep('NEEDLE', '.');
    expect(grep.ok).toBe(true);
    expect(grep.content).toMatch(/small\.txt/);
    expect(grep.content).not.toMatch(/huge\.txt/); // oversize file skipped
  });
});

describe('hasNestedUnboundedQuantifier', () => {
  it('flags a repeated group that contains an unbounded quantifier', () => {
    for (const p of ['(a+)+', '(a+)+$', '(a*)+', '([a-z]+)*', '(.*)*', '(\\d+){2,}', '((ab)+)+', '(a+b)+']) {
      expect(hasNestedUnboundedQuantifier(p)).toBe(true);
    }
  });

  it('allows benign patterns (no nested unbounded repetition)', () => {
    for (const p of ['def spin', 'a+b+', '(ab)+', '(a+)', '(a|b)*', 'foo\\+bar', '[+*]+', '(x){2,3}', 'a.*b']) {
      expect(hasNestedUnboundedQuantifier(p)).toBe(false);
    }
  });
});

describe('runPlanner', () => {
  let sourceRoot: string;
  let handbookDir: string;

  beforeAll(() => {
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-plan-src-'));
    handbookDir = mkdtempSync(join(tmpdir(), 'hb-plan-hb-'));
    mkdirSync(join(sourceRoot, 'app'));
    writeFileSync(
      join(sourceRoot, 'app', 'engine.py'),
      'class Engine:\n    def spin(self):\n        self.rpm += 1\n        return self.rpm\n',
    );
    writeFileSync(join(handbookDir, 'index.md'), '# Index\n\n- stage-1: Engine work — app/engine.py\n');
  });

  it('routes with the handbook, reads source, and finishes with a plan', async () => {
    const client = new MockChatClient([
      // Turn order is driven by what is already in the transcript.
      // Match on "## Tool result (" — with the paren, which only a real transcript
      // entry carries. Matching the bare phrase coupled these fixtures to the
      // prompt text, and adding the phrase to the protocol silently reordered them.
      {
        match: (p) => !p.includes('## Tool result ('),
        respond: { tool: 'list_dir', path: '__handbook__' },
      },
      {
        match: (p) => p.includes('## Tool result (list_dir)') && !p.includes('Tool result (read_file)'),
        respond: { tool: 'read_file', path: '__handbook__/index.md' },
      },
      {
        match: (p) => p.split('## Tool result (').length === 3,
        respond: { tool: 'read_file', path: 'app/engine.py' },
      },
      {
        match: () => true,
        respond: { tool: 'finish', plan: PLAN },
      },
    ]);
    const result = await runPlanner({
      client,
      sourceRoot,
      handbookDir,
      request: 'Make Engine.spin retry three times.',
    });
    expect(result.turns).toBe(4);
    expect(result.plan).toContain('### EDIT 1');
    expect(result.declarations?.willModify).toEqual(['Engine.spin']);
    expect(result.trace).toEqual([
      'list_dir(__handbook__)',
      'read_file(__handbook__/index.md)',
      'read_file(app/engine.py)',
    ]);
    // The handbook mount actually served the handbook file:
    const transcriptHadIndex = client.calls.some((c) => c.prompt.includes('stage-1: Engine work'));
    expect(transcriptHadIndex).toBe(true);
  });

  it('forces a finish at the turn limit', async () => {
    const client = new MockChatClient([
      { match: 'Turn limit reached', respond: { tool: 'finish', plan: 'best effort' } },
      { match: () => true, respond: { tool: 'list_dir', path: '.' } },
    ]);
    const result = await runPlanner({
      client,
      sourceRoot,
      request: 'anything',
      maxTurns: 3,
    });
    expect(result.turns).toBe(3);
    expect(result.plan).toBe('best effort');
  });

  it('rejects a reply that invents tool results, and never uses its plan', async () => {
    // Observed against a live endpoint: one reply carried an action block, then a
    // fabricated "## Tool result" section, then more actions built on top of it —
    // 13 in all — ending in EDIT blocks derived from a line that does not exist.
    const fabricated = [
      '```json\n{"tool":"read_file","path":"app/engine.py"}\n```',
      '',
      '## Tool result (read_file)',
      'app/engine.py lines 1-3 of 3:',
      '    1| def totally_invented():',
      '',
      '### EDIT 1',
      '- file: `app/engine.py`',
      '```old',
      'def totally_invented():',
      '```new',
      'def still_invented():',
      '```',
    ].join('\n');
    let calls = 0;
    const client = new MockChatClient([
      {
        match: () => true,
        respond: () => {
          calls += 1;
          return calls <= 2 ? fabricated : PLAN;
        },
      },
    ]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    // The fabricated EDIT block must not survive; the honest plan that came after does.
    expect(result.plan).not.toContain('still_invented');
    expect(result.plan).toContain('### EDIT 1');
    expect(result.declarations?.willModify).toEqual(['Engine.spin']);
    expect(result.aborted).toBeUndefined(); // recovered — not a failed run
    expect(calls).toBe(3); // two rejections, then the real answer
  });

  it('gives up rather than return a plan built on invented results', async () => {
    const fabricated = '```json\n{"tool":"grep","pattern":"x"}\n```\n\n## Tool result (grep)\nmade up\n\n### EDIT 1\n- file: `a.py`\n';
    const client = new MockChatClient([{ match: () => true, respond: fabricated }]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    expect(result.plan).toMatch(/kept inventing tool results/);
    expect(result.plan).not.toContain('### EDIT');
    expect(result.declarations).toBeUndefined();
    // The signal callers act on: a run that gave up must not look like a success.
    expect(result.aborted).toBe('fabrication');
  });

  it('does not pass off turn-limit chatter as a successful plan', async () => {
    // At the turn limit the model ignored the finish instruction and just chatted
    // (no action block, no EDIT blocks). Returning that prose as `plan` with no
    // `aborted` flag would report an abandoned run as a success — the same false
    // success the finish and fabrication paths already refuse.
    const client = new MockChatClient([{ match: () => true, respond: 'I am just chatting, no plan here.' }]);
    const result = await runPlanner({ client, sourceRoot, request: 'x', maxTurns: 3 });
    expect(result.turns).toBe(3);
    expect(result.aborted).toBe('turn-limit');
    expect(result.plan).not.toContain('chatting');
    expect(result.declarations).toBeUndefined();
  });

  it('does not dump the raw reply when finish carries no plan', async () => {
    const client = new MockChatClient([
      { match: () => true, respond: 'chatter about the code\n```json\n{"tool":"finish"}\n```' },
    ]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    expect(result.plan).toBe('(planner finished without producing a plan)');
    expect(result.plan).not.toContain('chatter');
    expect(result.aborted).toBe('no-plan');
  });

  it('accepts a prose answer containing EDIT blocks as the plan', async () => {
    const client = new MockChatClient([{ match: () => true, respond: PLAN }]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    expect(result.plan).toContain('### EDIT 1');
    expect(result.declarations?.willModify).toEqual(['Engine.spin']);
  });

  it('does not crash on a wrong-type tool argument (number/bool/object/array path or pattern)', async () => {
    // Tool args are raw model JSON. A numeric or boolean path/pattern used to
    // reach `truncate(...)` on the trace line and throw `text.slice is not a
    // function`, rejecting the whole run with an unhandled exception. Every
    // malformed shape must instead loop gracefully to the turn limit.
    const malformed: Array<Record<string, unknown>> = [
      { tool: 'read_file', path: 123 },
      { tool: 'list_dir', path: true },
      { tool: 'grep', pattern: 5, path: '.' },
      { tool: 'read_file', path: { nested: 1 } },
      { tool: 'grep', pattern: ['a', 'b'], path: '.' },
      { tool: 'list_dir', path: ['a', 'b'] },
    ];
    for (const action of malformed) {
      const client = new MockChatClient([{ match: () => true, respond: () => action }]);
      const result = await runPlanner({ client, sourceRoot, request: 'x', maxTurns: 3 });
      // Resolved (never rejected), terminated at the limit, no false success.
      expect(result.turns).toBe(3);
      expect(result.aborted).toBe('turn-limit');
    }
  });
});

describe('parseDeclarations', () => {
  it('takes the LAST json block and requires declaration keys', () => {
    const plan = '```json\n{"a":1}\n```\ntext\n```json\n{"will_modify":["X"],"will_add":[],"will_remove":[]}\n```';
    expect(parseDeclarations(plan)?.willModify).toEqual(['X']);
    expect(parseDeclarations('```json\n{"a":1}\n```')).toBeUndefined();
  });
});

describe('closeDanglingFence', () => {
  it('closes a final fence the model forgot', () => {
    // The real case: a correct 2-edit plan whose declarations block never closed,
    // which made the executor refuse the whole plan.
    const plan = '### EDIT 1\n```old\na\n```\n```new\nb\n```\n\n```json\n{"will_modify": []}';
    const out = closeDanglingFence(plan);
    expect(out.repaired).toBe(true);
    expect(out.plan.match(/```/g)).toHaveLength(6);
    expect(parseDeclarations(out.plan)?.willModify).toEqual([]);
  });

  it('leaves a balanced plan untouched', () => {
    const plan = '### EDIT 1\n```old\na\n```\n```new\nb\n```\n';
    expect(closeDanglingFence(plan)).toEqual({ plan, repaired: false });
  });

  it('matches the marker that was opened', () => {
    expect(closeDanglingFence('~~~old\nx').plan.trimEnd().endsWith('~~~')).toBe(true);
  });

  it('does not touch a plan whose fences are all closed but content is missing', () => {
    // Structural problems that are NOT a dangling delimiter stay for the executor
    // to refuse — this helper only ever closes one open fence at end of text.
    const plan = '### EDIT 1\n- file: `a.ts`\n```old\nx\n```\n';
    expect(closeDanglingFence(plan).repaired).toBe(false);
  });
});

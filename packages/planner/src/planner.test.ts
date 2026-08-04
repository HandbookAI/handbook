import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockChatClient } from '@handbook/llm';
import { parseDeclarations, runPlanner } from './planner.js';
import { ReadOnlyTools } from './tools.js';

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
    expect(calls).toBe(3); // two rejections, then the real answer
  });

  it('gives up rather than return a plan built on invented results', async () => {
    const fabricated = '```json\n{"tool":"grep","pattern":"x"}\n```\n\n## Tool result (grep)\nmade up\n\n### EDIT 1\n- file: `a.py`\n';
    const client = new MockChatClient([{ match: () => true, respond: fabricated }]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    expect(result.plan).toMatch(/kept inventing tool results/);
    expect(result.plan).not.toContain('### EDIT');
    expect(result.declarations).toBeUndefined();
  });

  it('does not dump the raw reply when finish carries no plan', async () => {
    const client = new MockChatClient([
      { match: () => true, respond: 'chatter about the code\n```json\n{"tool":"finish"}\n```' },
    ]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    expect(result.plan).toBe('(planner finished without producing a plan)');
    expect(result.plan).not.toContain('chatter');
  });

  it('accepts a prose answer containing EDIT blocks as the plan', async () => {
    const client = new MockChatClient([{ match: () => true, respond: PLAN }]);
    const result = await runPlanner({ client, sourceRoot, request: 'x' });
    expect(result.plan).toContain('### EDIT 1');
    expect(result.declarations?.willModify).toEqual(['Engine.spin']);
  });
});

describe('parseDeclarations', () => {
  it('takes the LAST json block and requires declaration keys', () => {
    const plan = '```json\n{"a":1}\n```\ntext\n```json\n{"will_modify":["X"],"will_add":[],"will_remove":[]}\n```';
    expect(parseDeclarations(plan)?.willModify).toEqual(['X']);
    expect(parseDeclarations('```json\n{"a":1}\n```')).toBeUndefined();
  });
});

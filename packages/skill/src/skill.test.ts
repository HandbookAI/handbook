import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileExists, sha256Hex } from '@handbook/core';
import type { Assignment } from '@handbook/core';
import { buildSkill } from './build.js';
import { validateSkill } from './validate.js';

function writeRenderedHandbook(dir: string): void {
  writeFileSync(join(dir, 'overview.md'), '# Demo\n\n## 🗺️ System Overview\n\nA demo.\n');
  writeFileSync(
    join(dir, 'index.md'),
    '# Demo — Stage Index\n\n## [Boot](stage-1.md) `stage-1` — 1 files\n\nBoots.\n\n## [Run](stage-2.md) `stage-2` — 1 files\n\nRuns.\n',
  );
  writeFileSync(
    join(dir, 'register.md'),
    '# Demo — State Flow\n\n| State register | Semantics | Stages touched |\n|---|---|---|\n',
  );
  writeFileSync(join(dir, 'stage-1.md'), '# Boot `stage-1`\n\nBoot page.\n');
  writeFileSync(join(dir, 'stage-2.md'), '# Run `stage-2`\n\nRun page.\n');
}

function writeAgentSite(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'how_to_use.md'), '# How to use this index\n\nSearch, then pick by duty line.\n');
  writeFileSync(join(dir, 'disambiguation.md'), '# Disambiguation\n\n- `boot` → stage-1 vs stage-2\n');
  writeFileSync(join(dir, 'index.md'), '# Agent locator index\n');
  writeFileSync(join(dir, 'stage-1.md'), 'agent copy of stage-1\n');
}

/**
 * Byte-exact output of `buildSkill({ name: 'demo', project: 'Demo' })` with
 * agentDir/lang omitted. Deliberately updated when the SKILL.md protocol
 * grows (e.g. the Corrections section) — it exists to catch UNINTENDED drift.
 */
const LEGACY_SKILL_MD =
  '---\nname: demo-handbook\ndescription: Navigate the Demo codebase by behavior and source location. Use when planning, implementing, debugging, or reviewing Demo work that is unfamiliar, spans multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to Demo or isolated edits where the exact file is already known and no cross-cutting impact is plausible.\n---\n\n# Demo Handbook — how to use it\n\nThis handbook is a **location index** for the Demo codebase, not a code description.\nUse it to decide WHICH files, functions and state a change must touch — then read the real source.\n\n1. Read `references/overview.md` for the system\'s shape.\n2. Route through `references/index.md` — the stage index maps every subsystem to its files.\n3. Open only the relevant `references/stages/<id>.md` pages.\n4. Check `references/registers.md` for cross-cutting state — invaluable for fan-out changes.\n5. `read_file` the actual source at every cited path before proposing or making changes.\n\nIf `references/coverage.json` exists, treat its content hashes as freshness signals: a stale\nhash means the page may lag the code. Do NOT treat handbook prose as ground truth for code\ntext — always confirm against the real source before emitting a verbatim edit.\n\n## Corrections\n\nWhen a handbook claim contradicts the real source ("the handbook says X is in file A; it is\nactually in B"), report it: append ONE line of JSON to `corrections.jsonl` at the skill root\n(next to this SKILL.md — never under `references/`, which planners mount read-only). Create\nthe file on first write. One object per line:\n\n```json\n{"file": "src/engine.py", "page": "references/stages/stage-2.md", "claim": "spin() is defined in src/main.py", "actual": "spin() is defined in src/engine.py", "notedAt": "2026-08-04T12:00:00Z"}\n```\n\n`file` is the repo-relative source path (required); `page` is the references/ page that\ncarried the claim; `claim`/`actual` state the contradiction; `notedAt` is an ISO timestamp —\nall optional. Never edit anything under `references/` yourself: a later resync consumes\n`corrections.jsonl` and refreshes exactly the named files. Keep working from the real source.\n';

/** Byte-exact synthetic registers fallback before lang existed. */
const LEGACY_REGISTERS_FALLBACK =
  '# State registers\n\n_No cross-stage state registers were identified for this codebase._\n';

function frontmatter(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  return match ? match[0] : '';
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
    for (const rel of [
      'SKILL.md',
      'references/overview.md',
      'references/index.md',
      'references/registers.md',
      'references/stages/stage-1.md',
      'references/coverage.json',
    ]) {
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

  it('flags coverage that lists a since-deleted source file', () => {
    const hb = mkdtempSync(join(tmpdir(), 'hb-del-'));
    writeRenderedHandbook(hb);
    const out = join(mkdtempSync(join(tmpdir(), 'hb-delout-')), 'skill');
    const src = mkdtempSync(join(tmpdir(), 'hb-delsrc-'));
    mkdirSync(join(src, 'src'), { recursive: true });
    writeFileSync(join(src, 'src', 'a.py'), 'def a():\n    pass\n');
    writeFileSync(join(src, 'src', 'b.py'), 'def b():\n    pass\n');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', coverage: { assignment, sourceRoot: src } });
    // A clean build validates against its own source…
    expect(validateSkill({ skillDir: out, sourceRoot: src }).ok).toBe(true);
    // …but once a covered file is deleted, coverage must call it out.
    rmSync(join(src, 'src', 'b.py'));
    const result = validateSkill({ skillDir: out, sourceRoot: src });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/deleted files: .*src\/b\.py/);
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
    expect(() => buildSkill({ handbookDir: empty, outDir: join(empty, 'out'), name: 'x' })).toThrow(
      /index\.md/,
    );
  });
});

describe('buildSkill without agentDir/lang (legacy contract)', () => {
  it('emits byte-identical output when the new options are omitted', () => {
    const hb = mkdtempSync(join(tmpdir(), 'hb-legacy-'));
    writeRenderedHandbook(hb);
    rmSync(join(hb, 'register.md'));
    const out = join(hb, 'out');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', project: 'Demo' });
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).toBe(LEGACY_SKILL_MD);
    expect(readFileSync(join(out, 'references', 'registers.md'), 'utf8')).toBe(LEGACY_REGISTERS_FALLBACK);
    expect(fileExists(join(out, 'references', 'agent'))).toBe(false);
  });

  it('ignores agentDir when the locator pages are absent', () => {
    const hb = mkdtempSync(join(tmpdir(), 'hb-noagent-'));
    writeRenderedHandbook(hb);
    const bareAgent = join(hb, 'agent-empty');
    mkdirSync(bareAgent);
    const out = join(hb, 'out');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', project: 'Demo', agentDir: bareAgent });
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).toBe(LEGACY_SKILL_MD);
    expect(fileExists(join(out, 'references', 'agent'))).toBe(false);
  });
});

describe('buildSkill with agentDir', () => {
  let hb: string;
  let out: string;

  beforeAll(() => {
    hb = mkdtempSync(join(tmpdir(), 'hb-agent-'));
    writeRenderedHandbook(hb);
    writeAgentSite(join(hb, 'agent'));
    out = join(hb, 'out');
  });

  it('copies the locator pages into references/agent/ and keeps stage discovery untouched', () => {
    const result = buildSkill({
      handbookDir: hb,
      outDir: out,
      name: 'demo',
      project: 'Demo',
      agentDir: join(hb, 'agent'),
    });
    expect(result.nStagePages).toBe(2);
    expect(readFileSync(join(out, 'references', 'agent', 'how_to_use.md'), 'utf8')).toContain('duty line');
    expect(readFileSync(join(out, 'references', 'agent', 'disambiguation.md'), 'utf8')).toContain(
      'Disambiguation',
    );
    // Only the two locator pages ship — never the agent site's index/stage copies.
    expect(fileExists(join(out, 'references', 'agent', 'index.md'))).toBe(false);
    expect(fileExists(join(out, 'references', 'agent', 'stage-1.md'))).toBe(false);
    expect(fileExists(join(out, 'references', 'stages', 'how_to_use.md'))).toBe(false);
    expect(result.references).toContain('agent/how_to_use.md');
    expect(result.references).toContain('agent/disambiguation.md');
  });

  it('extends the routing protocol with an agent-locator step', () => {
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8');
    expect(skill).toContain('references/agent/disambiguation.md');
    expect(skill).toContain('references/agent/how_to_use.md');
    // Reading the real source stays the final numbered step.
    const agentStep = skill.indexOf('references/agent/disambiguation.md');
    const sourceStep = skill.indexOf('`read_file` the actual source');
    expect(agentStep).toBeGreaterThan(-1);
    expect(sourceStep).toBeGreaterThan(agentStep);
    expect(frontmatter(skill)).toBe(frontmatter(LEGACY_SKILL_MD));
  });

  it('validates clean, including the agent pages', () => {
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('agent'))).toEqual([]);
  });
});

describe('buildSkill lang: zh', () => {
  let hb: string;
  let out: string;

  beforeAll(() => {
    hb = mkdtempSync(join(tmpdir(), 'hb-zh-'));
    writeRenderedHandbook(hb);
    rmSync(join(hb, 'register.md'));
    writeAgentSite(join(hb, 'agent'));
    out = join(hb, 'out');
    buildSkill({
      handbookDir: hb,
      outDir: out,
      name: 'demo',
      project: 'Demo',
      agentDir: join(hb, 'agent'),
      lang: 'zh',
    });
  });

  it('localizes the body but keeps the English frontmatter byte-for-byte', () => {
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8');
    expect(frontmatter(skill)).toBe(frontmatter(LEGACY_SKILL_MD));
    expect(skill).toContain('位置索引');
    expect(skill).toContain('references/index.md');
    expect(skill).toContain('references/agent/disambiguation.md');
    expect(skill).toContain('真实源码');
  });

  it('carries the corrections protocol in the Chinese body', () => {
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8');
    expect(skill).toContain('更正记录');
    expect(skill).toContain('corrections.jsonl');
    expect(skill).toContain('{"file": "src/engine.py", "page": "references/stages/stage-2.md"');
  });

  it('localizes the synthetic no-registers fallback', () => {
    const registers = readFileSync(join(out, 'references', 'registers.md'), 'utf8');
    expect(registers).toContain('状态寄存器');
  });

  it('passes validation with a Chinese body', () => {
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
  });
});

describe('corrections channel', () => {
  function buildOnce(): { hb: string; out: string } {
    const hb = mkdtempSync(join(tmpdir(), 'hb-corr-'));
    writeRenderedHandbook(hb);
    const out = join(hb, 'out');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', project: 'Demo' });
    return { hb, out };
  }

  it('never creates corrections.jsonl at build time — the agent creates it on first write', () => {
    const { out } = buildOnce();
    expect(fileExists(join(out, 'corrections.jsonl'))).toBe(false);
  });

  it('preserves an existing corrections.jsonl across a rebuild into the same outDir', () => {
    const { hb, out } = buildOnce();
    const pending = '{"file": "src/a.py", "claim": "wrong", "actual": "right"}\n';
    writeFileSync(join(out, 'corrections.jsonl'), pending);
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', project: 'Demo' });
    expect(readFileSync(join(out, 'corrections.jsonl'), 'utf8')).toBe(pending);
    // The rest of the package is still rebuilt from scratch.
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).toBe(LEGACY_SKILL_MD);
  });

  it('validates silently when corrections.jsonl is absent', () => {
    const { out } = buildOnce();
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('correction'))).toEqual([]);
  });

  it('warns with the count of valid pending corrections', () => {
    const { out } = buildOnce();
    writeFileSync(
      join(out, 'corrections.jsonl'),
      '{"file": "src/a.py"}\n\n{"file": "src/b.py", "notedAt": "2026-08-04T12:00:00Z"}\n',
    );
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      '2 unprocessed correction(s) — resync with --corrections to fold them in',
    );
  });

  it('errors on malformed lines, naming the line number', () => {
    const { out } = buildOnce();
    writeFileSync(
      join(out, 'corrections.jsonl'),
      '{"file": "src/a.py"}\nnot json\n{"page": "references/index.md"}\n{"file": ""}\n',
    );
    const result = validateSkill({ skillDir: out });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/corrections\.jsonl line 2.*JSON/);
    expect(result.errors.join('\n')).toMatch(/corrections\.jsonl line 3/);
    expect(result.errors.join('\n')).toMatch(/corrections\.jsonl line 4/);
    // The one valid record still counts as pending work.
    expect(result.warnings).toContain(
      '1 unprocessed correction(s) — resync with --corrections to fold them in',
    );
  });
});

describe('validateSkill references/agent/ coverage', () => {
  function buildWithAgent(): string {
    const hb = mkdtempSync(join(tmpdir(), 'hb-vagent-'));
    writeRenderedHandbook(hb);
    writeAgentSite(join(hb, 'agent'));
    const out = join(hb, 'out');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', agentDir: join(hb, 'agent') });
    return out;
  }

  it('warns (not errors) when only one locator page is present', () => {
    const out = buildWithAgent();
    rmSync(join(out, 'references', 'agent', 'disambiguation.md'));
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/agent\/.*disambiguation\.md/);
  });

  it('errors when a locator page is empty', () => {
    const out = buildWithAgent();
    writeFileSync(join(out, 'references', 'agent', 'how_to_use.md'), '');
    const result = validateSkill({ skillDir: out });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/agent\/how_to_use\.md.*empty/);
  });
});

describe('validateSkill SKILL.md frontmatter — EOL / BOM tolerance', () => {
  function builtSkill(): string {
    const hb = mkdtempSync(join(tmpdir(), 'hb-eol-'));
    writeRenderedHandbook(hb);
    const out = join(hb, 'out');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', project: 'Demo' });
    return out;
  }

  // A SKILL.md checked out on Windows (or under git autocrlf) carries CRLF
  // endings; corrections.jsonl is already parsed CRLF-tolerantly, so the
  // frontmatter must be too — otherwise a byte-for-byte valid skill was
  // rejected with a spurious "no YAML frontmatter".
  it('parses frontmatter written with CRLF line endings', () => {
    const out = builtSkill();
    const skillPath = join(out, 'SKILL.md');
    const lf = readFileSync(skillPath, 'utf8');
    // Sanity: the fixture really is LF-only before we convert it.
    expect(lf.includes('\r\n')).toBe(false);
    writeFileSync(skillPath, lf.replace(/\n/g, '\r\n'));
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('parses frontmatter behind a leading UTF-8 BOM', () => {
    const out = builtSkill();
    const skillPath = join(out, 'SKILL.md');
    writeFileSync(skillPath, '\uFEFF' + readFileSync(skillPath, 'utf8'));
    const result = validateSkill({ skillDir: out });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('still reports a genuinely missing frontmatter block', () => {
    const out = builtSkill();
    writeFileSync(join(out, 'SKILL.md'), '# no frontmatter here\n\nreferences/index.md real source\n');
    const result = validateSkill({ skillDir: out });
    expect(result.errors.join('\n')).toMatch(/no YAML frontmatter/);
  });
});

describe('deep adversarial pass 2', () => {
  function builtSkill(): string {
    const hb = mkdtempSync(join(tmpdir(), 'hb-a2-'));
    writeRenderedHandbook(hb);
    const out = join(mkdtempSync(join(tmpdir(), 'hb-a2out-')), 'skill');
    buildSkill({ handbookDir: hb, outDir: out, name: 'demo', project: 'Demo' });
    return out;
  }

  // A2-D4: `buildSkill` starts by wiping outDir. Targeting the handbook itself
  // (or an ancestor of it) would delete the source it is meant to package and
  // then silently emit a broken, empty skill. It must refuse up front.
  it('refuses to build into the handbook directory itself', () => {
    const hb = mkdtempSync(join(tmpdir(), 'hb-selfdest-'));
    writeRenderedHandbook(hb);
    expect(() => buildSkill({ handbookDir: hb, outDir: hb, name: 'demo', project: 'Demo' })).toThrow(
      /delete the source|must not be the handbook/,
    );
    // The source handbook survives the refusal untouched.
    expect(fileExists(join(hb, 'index.md'))).toBe(true);
    expect(fileExists(join(hb, 'stage-1.md'))).toBe(true);
  });

  it('refuses to build into an ancestor of the handbook directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hb-anc-'));
    const hb = join(parent, 'rendered');
    mkdirSync(hb, { recursive: true });
    writeRenderedHandbook(hb);
    expect(() => buildSkill({ handbookDir: hb, outDir: parent, name: 'demo', project: 'Demo' })).toThrow(
      /delete the source|ancestor/,
    );
    expect(fileExists(join(hb, 'index.md'))).toBe(true);
  });

  // A2-D5: a coverage path that escapes the source root (`../`, absolute,
  // backslash) would make the validator read — and hash — arbitrary off-tree
  // files. It must be flagged, not followed.
  it('refuses a coverage.json path that escapes the source root', () => {
    const out = builtSkill();
    const src = mkdtempSync(join(tmpdir(), 'hb-a2-src-'));
    writeFileSync(
      join(out, 'references', 'coverage.json'),
      JSON.stringify({
        files: [{ path: '../../../../../../etc/passwd', stage: 'stage-1', sha256: 'deadbeef' }],
      }),
    );
    const result = validateSkill({ skillDir: out, sourceRoot: src });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/escape the source root/);
    // It must not have hashed anything outside the root and called it "stale".
    expect(result.errors.join('\n')).not.toMatch(/stale/);
  });

  // A2-D6: a malformed coverage entry (null, string, wrong-typed) must not
  // derail drift detection with a misleading "unreadable" — the real deleted /
  // stale files still have to be reported.
  it('reports genuine drift even when a coverage entry is malformed', () => {
    const out = builtSkill();
    const src = mkdtempSync(join(tmpdir(), 'hb-a2-src2-'));
    mkdirSync(join(src, 'src'), { recursive: true });
    writeFileSync(join(src, 'src', 'present.py'), 'ok\n');
    writeFileSync(
      join(out, 'references', 'coverage.json'),
      JSON.stringify({
        files: [
          null,
          'a-string',
          { path: 'src/present.py', sha256: sha256Hex('ok\n') },
          { path: 'src/gone.py', sha256: 'abc123' },
        ],
      }),
    );
    const result = validateSkill({ skillDir: out, sourceRoot: src });
    expect(result.ok).toBe(false);
    const joined = result.errors.join('\n');
    expect(joined).not.toMatch(/unreadable/);
    expect(joined).toMatch(/deleted files: .*src\/gone\.py/);
  });

  // A2-D7: a Map silently let a second `name:` overwrite the first. Duplicate
  // frontmatter keys are ambiguous and must be flagged.
  it('flags a duplicate frontmatter key', () => {
    const out = builtSkill();
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8');
    const doubled = skill.replace('name: demo-handbook\n', 'name: demo-handbook\nname: other-handbook\n');
    writeFileSync(join(out, 'SKILL.md'), doubled);
    const result = validateSkill({ skillDir: out });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/duplicate "name" key/);
  });
});

/**
 * Package a rendered handbook directory as an agent SKILL:
 *
 * ```
 * <out>/
 *   SKILL.md                 navigation guide (how an agent should route)
 *   references/
 *     overview.md  index.md  registers.md
 *     stages/<sid>.md        one page per stage
 *     agent/                 how_to_use.md + disambiguation.md (optional, from the agent site)
 *     coverage.json          file → stage + content hashes (optional, drift signal)
 * ```
 *
 * The skill is self-contained and shareable; it never embeds source code.
 */
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import {
  PIPELINE_DEFAULTS,
  ensureDir,
  fileExists,
  listFilesRecursive,
  sha256Hex,
  writeFileAtomic,
  writeJsonFile,
  type Assignment,
  type NarrateLang,
} from '@handbook/core';

export interface BuildSkillOptions {
  /** Rendered handbook dir (contains overview.md/index.md/register.md/<sid>.md). */
  handbookDir: string;
  outDir: string;
  /** Skill slug, e.g. `myproject`. Produces name `<slug>-handbook`. */
  name: string;
  /** Human project name used in prose. Defaults to `name`. */
  project?: string;
  /** When given, coverage.json records file→stage plus source hashes for drift detection. */
  coverage?: { assignment: Assignment; sourceRoot?: string };
  /**
   * Rendered agent locator site. When it contains both `how_to_use.md` and
   * `disambiguation.md`, they ship under `references/agent/` and the SKILL.md
   * routing protocol gains a disambiguation step. Omitted (or missing pages):
   * output is byte-identical to a build without this option.
   */
  agentDir?: string;
  /**
   * Language of the SKILL.md BODY and synthetic fallback prose (default `en`).
   * The YAML frontmatter (`name` + `description`) stays English regardless:
   * agent runtimes route skills on the description text, and the validated
   * "Use when …" / "Do not use …" contract is part of that routing surface —
   * translating it would silently break skill selection.
   */
  lang?: NarrateLang;
}

export interface BuildSkillResult {
  outDir: string;
  nStagePages: number;
  references: string[];
}

/** Root-level pages that are NOT stage pages in a flat rendered handbook. */
const NON_STAGE_PAGES = new Set([
  'overview.md',
  'index.md',
  'register.md',
  'registers.md',
  'how_to_use.md',
  'disambiguation.md',
  'readme.md',
]);

/** SKILL.md body copy plus synthetic fallback prose, per narrate language. */
interface SkillCopy {
  header: (project: string) => string;
  /** Unnumbered routing steps; `agent` is spliced in before `source` when the locator pages ship. */
  steps: {
    overview: string;
    index: string;
    stages: string;
    registers: string;
    agent: string;
    source: string;
  };
  coverage: string;
  /** The corrections protocol: how a consuming agent reports handbook↔source contradictions. */
  corrections: string;
  noRegisters: string;
}

/**
 * The one-line JSON example shown verbatim in every SKILL.md body (both
 * languages): agents copy its shape, so it must match `corrections.jsonl`'s
 * contract exactly — `file` required, the rest optional.
 */
const CORRECTION_EXAMPLE =
  '{"file": "src/engine.py", "page": "references/stages/stage-2.md", "claim": "spin() is defined in src/main.py", "actual": "spin() is defined in src/engine.py", "notedAt": "2026-08-04T12:00:00Z"}';

const SKILL_COPY: Record<NarrateLang, SkillCopy> = {
  en: {
    header: (project) => `# ${project} Handbook — how to use it

This handbook is a **location index** for the ${project} codebase, not a code description.
Use it to decide WHICH files, functions and state a change must touch — then read the real source.`,
    steps: {
      overview: "Read `references/overview.md` for the system's shape.",
      index: 'Route through `references/index.md` — the stage index maps every subsystem to its files.',
      stages: 'Open only the relevant `references/stages/<id>.md` pages.',
      registers: 'Check `references/registers.md` for cross-cutting state — invaluable for fan-out changes.',
      agent:
        'When a term is ambiguous or a search hits many stages, check `references/agent/disambiguation.md`; `references/agent/how_to_use.md` documents the agent-side search protocol.',
      source: '`read_file` the actual source at every cited path before proposing or making changes.',
    },
    coverage: `If \`references/coverage.json\` exists, treat its content hashes as freshness signals: a stale
hash means the page may lag the code. Do NOT treat handbook prose as ground truth for code
text — always confirm against the real source before emitting a verbatim edit.`,
    corrections: `## Corrections

When a handbook claim contradicts the real source ("the handbook says X is in file A; it is
actually in B"), report it: append ONE line of JSON to \`corrections.jsonl\` at the skill root
(next to this SKILL.md — never under \`references/\`, which planners mount read-only). Create
the file on first write. One object per line:

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` is the repo-relative source path (required); \`page\` is the references/ page that
carried the claim; \`claim\`/\`actual\` state the contradiction; \`notedAt\` is an ISO timestamp —
all optional. Never edit anything under \`references/\` yourself: a later resync consumes
\`corrections.jsonl\` and refreshes exactly the named files. Keep working from the real source.`,
    noRegisters: '# State registers\n\n_No cross-stage state registers were identified for this codebase._\n',
  },
  zh: {
    header: (project) => `# ${project} 手册 —— 使用说明

本手册是 ${project} 代码库的**位置索引**，不是代码描述。
用它来决定一次修改必须触及哪些文件、函数与状态 —— 然后去读真实源码。`,
    steps: {
      overview: '先读 `references/overview.md`，了解系统的整体形状。',
      index: '通过 `references/index.md` 路由 —— 阶段索引把每个子系统映射到它的文件。',
      stages: '只打开相关的 `references/stages/<id>.md` 页面。',
      registers: '查 `references/registers.md` 的跨阶段状态 —— 对波及面大的修改尤其关键。',
      agent:
        '当一个词含义不明、或搜索命中多个阶段时，查 `references/agent/disambiguation.md`；`references/agent/how_to_use.md` 记录了 agent 侧的完整检索规程。',
      source: '在提出或做出任何修改之前，`read_file` 每个被引用路径的真实源码。',
    },
    coverage: `如果 \`references/coverage.json\` 存在，把其中的内容哈希当作新鲜度信号：哈希过期意味着
页面可能落后于代码。不要把手册散文当作代码文本的事实依据 —— 在输出逐字修改之前，
务必对照真实源码确认。`,
    corrections: `## 更正记录（Corrections）

当手册的断言与真实源码矛盾时（「手册说 X 在文件 A，实际在 B」），请上报：向 skill 根目录的
\`corrections.jsonl\`（与本 SKILL.md 同级 —— 绝不写进 \`references/\`，那棵树是只读挂载的）
追加一行 JSON，文件不存在就先创建。每行一个对象：

\`\`\`json
${CORRECTION_EXAMPLE}
\`\`\`

\`file\` 是仓库相对的源码路径（必填）；\`page\` 是承载该断言的 references/ 页面；
\`claim\`/\`actual\` 陈述矛盾本身；\`notedAt\` 是 ISO 时间戳 —— 除 \`file\` 外均可选。
绝不要自己改动 \`references/\` 下的任何内容：之后的 resync 会消费 \`corrections.jsonl\`，
只刷新被点名的文件。在此期间继续以真实源码为准。`,
    noRegisters: '# 状态寄存器\n\n_本代码库未识别出跨阶段的状态寄存器。_\n',
  },
};

function skillMd(name: string, project: string, lang: NarrateLang, withAgentPages: boolean): string {
  const copy = SKILL_COPY[lang];
  const steps = [copy.steps.overview, copy.steps.index, copy.steps.stages, copy.steps.registers];
  if (withAgentPages) steps.push(copy.steps.agent);
  steps.push(copy.steps.source);
  const protocol = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
  // The frontmatter is intentionally NOT localized: agent runtimes route on
  // the description ("Use when …" / "Do not use …" is a validated contract),
  // so it must stay English even when the body is Chinese.
  return `---
name: ${name}-handbook
description: Navigate the ${project} codebase by behavior and source location. Use when planning, implementing, debugging, or reviewing ${project} work that is unfamiliar, spans multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to ${project} or isolated edits where the exact file is already known and no cross-cutting impact is plausible.
---

${copy.header(project)}

${protocol}

${copy.coverage}

${copy.corrections}
`;
}

/** The two locator pages of a rendered agent site that ship with the skill. */
const AGENT_LOCATOR_PAGES = ['how_to_use.md', 'disambiguation.md'] as const;

export function buildSkill(options: BuildSkillOptions): BuildSkillResult {
  const { handbookDir, outDir } = options;
  const project = options.project ?? options.name;
  const lang = options.lang ?? PIPELINE_DEFAULTS.narrateLang;
  if (!fileExists(join(handbookDir, 'index.md'))) {
    throw new Error(`${handbookDir} is not a rendered handbook (missing index.md)`);
  }
  // The build starts by wiping outDir. If outDir IS the handbook (or the handbook
  // sits inside it), that clean would destroy the very source we are packaging —
  // and then silently produce a broken, empty skill. Refuse both up front.
  const outAbs = resolve(outDir);
  const handbookAbs = resolve(handbookDir);
  if (outAbs === handbookAbs || handbookAbs.startsWith(outAbs + sep)) {
    throw new Error(
      `outDir must not be the handbook directory or an ancestor of it (outDir=${outAbs}, handbookDir=${handbookAbs}) — packaging would delete the source`,
    );
  }
  // Agent locator pages ship only as a pair: SKILL.md must never route to a
  // file that does not exist, and half a locator is what the validator warns on.
  const agentSite = options.agentDir;
  const agentDir =
    agentSite && AGENT_LOCATOR_PAGES.every((p) => fileExists(join(agentSite, p))) ? agentSite : undefined;
  // corrections.jsonl is AGENT-owned feedback (see the SKILL.md protocol):
  // the builder never creates it, and a rebuild into the same outDir must not
  // wipe records that have not been resynced yet — stash it across the clean.
  const correctionsPath = join(outDir, 'corrections.jsonl');
  const pendingCorrections = fileExists(correctionsPath) ? readFileSync(correctionsPath, 'utf8') : undefined;
  rmSync(outDir, { recursive: true, force: true });
  const referencesDir = join(outDir, 'references');
  const stagesDir = join(referencesDir, 'stages');
  ensureDir(stagesDir);
  if (pendingCorrections !== undefined) writeFileAtomic(correctionsPath, pendingCorrections);

  writeFileAtomic(join(outDir, 'SKILL.md'), skillMd(options.name, project, lang, agentDir !== undefined));

  const references: string[] = [];
  if (agentDir) {
    const agentOut = join(referencesDir, 'agent');
    ensureDir(agentOut);
    for (const page of AGENT_LOCATOR_PAGES) {
      copyFileSync(join(agentDir, page), join(agentOut, page));
      references.push(`agent/${page}`);
    }
  }
  const copyMap: Array<[string, string[]]> = [
    ['overview.md', ['overview.md']],
    ['index.md', ['index.md']],
    ['registers.md', ['registers.md', 'register.md']],
  ];
  for (const [dest, candidates] of copyMap) {
    const source = candidates.map((c) => join(handbookDir, c)).find(fileExists);
    if (source) {
      copyFileSync(source, join(referencesDir, dest));
      references.push(dest);
    }
  }
  // A handbook with zero registers renders no register page; the skill still
  // ships one so the reference layout (and the validator contract) is stable.
  if (!references.includes('registers.md')) {
    writeFileAtomic(join(referencesDir, 'registers.md'), SKILL_COPY[lang].noRegisters);
    references.push('registers.md');
  }

  // Stage pages: nested stages/ dir wins, else flat `<sid>.md` at the root.
  let stagePages: string[];
  if (fileExists(join(handbookDir, 'stages'))) {
    stagePages = listFilesRecursive(join(handbookDir, 'stages'), { extensions: ['.md'] });
    for (const page of stagePages) {
      copyFileSync(join(handbookDir, 'stages', page), join(stagesDir, basename(page)));
    }
  } else {
    // Flat layout: stage pages are every root-level .md that isn't a known
    // top-level page — stage ids are arbitrary (LLM- or user-authored), so a
    // name-shape filter would silently drop pages. Do NOT recurse: sub-sites
    // (agent/, html/) carry their own copies of the stage pages.
    stagePages = listFilesRecursive(handbookDir, { extensions: ['.md'] }).filter(
      (f) => !f.includes('/') && !NON_STAGE_PAGES.has(basename(f).toLowerCase()),
    );
    for (const page of stagePages) {
      copyFileSync(join(handbookDir, page), join(stagesDir, basename(page)));
    }
  }

  if (options.coverage) {
    const { assignment, sourceRoot } = options.coverage;
    const files = Object.entries(assignment.fileStage)
      .map(([file, entry]) => {
        let sha = '';
        if (sourceRoot) {
          try {
            sha = sha256Hex(readFileSync(join(sourceRoot, file)));
          } catch {
            sha = '';
          }
        }
        return { path: file, stage: entry.stage, sha256: sha };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    writeJsonFile(join(referencesDir, 'coverage.json'), {
      schemaVersion: 1,
      summary: {
        eligibleFiles: files.length,
        stages: Object.fromEntries(
          Object.entries(assignment.buckets).map(([sid, bucket]) => [sid, bucket.length]),
        ),
      },
      files,
    });
    references.push('coverage.json');
  }

  return { outDir, nStagePages: stagePages.length, references };
}

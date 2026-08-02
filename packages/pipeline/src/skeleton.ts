/**
 * Phase 2b (step A) — synthesize the stage skeleton: the handbook's ordered
 * narrative spine, drafted from a per-directory rollup of file purposes plus
 * the call-graph entry points.
 */
import type { NavPack } from '@handbook/analyzer';
import type { ChatClient } from '@handbook/llm';
import type { FileCard, NarrateLang, Skeleton, Stage } from '@handbook/core';

export interface DirRollup {
  dir: string;
  nFiles: number;
  roles: Array<{ role: string; count: number }>;
  lifecycles: string[];
  examples: string[];
}

/** Group card purposes by directory for the synthesis prompt. */
export function dirRollups(cards: Record<string, FileCard>, examplesPerDir = 4): DirRollup[] {
  const byDir = new Map<string, FileCard[]>();
  for (const [file, card] of Object.entries(cards)) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
    const list = byDir.get(dir) ?? [];
    list.push(card);
    byDir.set(dir, list);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, dirCards]) => {
      const roleCounts = new Map<string, number>();
      const lifecycleCounts = new Map<string, number>();
      for (const card of dirCards) {
        roleCounts.set(card.role, (roleCounts.get(card.role) ?? 0) + 1);
        if (card.lifecycle && card.lifecycle !== 'none') {
          lifecycleCounts.set(card.lifecycle, (lifecycleCounts.get(card.lifecycle) ?? 0) + 1);
        }
      }
      return {
        dir,
        nFiles: dirCards.length,
        roles: [...roleCounts.entries()].sort((a, b) => b[1] - a[1]).map(([role, count]) => ({ role, count })),
        lifecycles: [...lifecycleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l),
        examples: dirCards
          .map((c) => c.purpose)
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)
          .slice(0, examplesPerDir),
      };
    });
}

const SYNTH_RULES_EN = `You are dividing a large codebase into the STAGES of a system handbook, using a per-directory
rollup of file purposes plus the call-graph entry points. Produce the high-altitude NARRATIVE SPINE
of the system.
Rules:
- Order main stages by EXECUTION/LIFECYCLE, not alphabetically: entry points → setup → dispatch →
  main loop / request handling → per-unit work → teardown. Use the lifecycle hints.
- Aim for 12-25 top-level stages for a large system (fewer is fine for a small one).
- Use substages (a "parent" id, child ids like "stage-3.1") for depth instead of overcrowding one level.
- Genuinely cross-cutting infrastructure (logging/telemetry, config, protocol/types, generic utils,
  persistence) becomes stages with "crosscut": true AFTER the main flow.
- Every rollup directory must be coverable by some stage.
- Descriptions must be concrete enough that a later pass can assign individual files to stages.
Output ONLY one JSON block:
\`\`\`json
{"metadata": {"archetype": "<one phrase for what kind of system this is>"},
 "stages": [{"id": "stage-1", "title": "...", "description": "...", "parent": null, "crosscut": false}]}
\`\`\``;

const SYNTH_RULES_ZH = `你在为一个代码库划分系统手册的"阶段"（stages），依据是按目录汇总的文件用途和调用图入口点。
产出系统的高空叙事主线。规则与英文版相同（阶段按执行/生命周期排序；12-25 个顶层阶段；用 parent 建子阶段；
横切基础设施放主线之后并标 "crosscut": true；描述要具体到能支撑后续逐文件指派）。
JSON key、id、布尔值用英文；title 与 description 用中文。只输出一个 JSON 块（schema 同英文版）。`;

export function buildSynthPrompt(nav: NavPack, rollups: DirRollup[], lang: NarrateLang): string {
  const rules = lang === 'zh' ? SYNTH_RULES_ZH : SYNTH_RULES_EN;
  const lines: string[] = [rules];
  lines.push(
    `## System: language=${nav.language} files=${nav.totals.nFiles} functions=${nav.totals.nFunctions} dirs=${nav.totals.nDirs}`,
  );
  lines.push('## Entry-point candidates');
  for (const e of nav.entryPoints.slice(0, 25)) {
    lines.push(`- [${e.isRoot ? 'root' : 'hint'}] ${e.qualname}  ${e.file}:${e.lineStart}  →${e.nCallees} callees`);
  }
  lines.push(`## Directory rollup (${rollups.length} dirs)`);
  for (const r of rollups) {
    const roles = r.roles.map((x) => `${x.role}×${x.count}`).join(', ');
    const lifecycle = r.lifecycles.length ? `; lifecycle=${r.lifecycles.join('/')}` : '';
    lines.push(`- ${r.dir}  (${r.nFiles}f) roles=[${roles}]${lifecycle}`);
    for (const example of r.examples) lines.push(`    · ${example}`);
  }
  return lines.join('\n');
}

/**
 * Stage ids become page filenames — restrict to filename-safe characters so a
 * hostile/hallucinated id (`../x`, `a/b`) can never escape the output dir.
 */
function sanitizeStageId(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '');
}

/**
 * Page names owned by the renderers/skill — a stage id colliding with one of
 * these (case-insensitively) would overwrite a fixed page, so such ids get
 * suffixed exactly like duplicates.
 */
const RESERVED_STAGE_IDS = new Set([
  'overview',
  'index',
  'register',
  'registers',
  'how_to_use',
  'disambiguation',
  'readme',
  'handbook',
]);

/** Coerce a raw LLM skeleton into the canonical, internally-consistent form. */
export function normalizeSkeleton(raw: unknown, draftedBy = 'skeleton-synth'): Skeleton {
  const rawObj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawStages = Array.isArray(rawObj.stages) ? rawObj.stages : [];
  const seen = new Set<string>(RESERVED_STAGE_IDS);
  const stages: Stage[] = [];
  // Original id → final id for ids that got renamed (sanitized, reserved, or
  // duplicated). Children referencing the ORIGINAL id follow the first rename
  // instead of being orphaned to the top level.
  const renames = new Map<string, string>();
  rawStages.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const s = entry as Record<string, unknown>;
    const crosscut = s.crosscut === true;
    const fallbackId = `${crosscut ? 'crosscut' : 'stage'}-${index + 1}`;
    const originalId = typeof s.id === 'string' ? s.id.trim() : '';
    let id = originalId && sanitizeStageId(originalId) ? sanitizeStageId(originalId) : fallbackId;
    while (seen.has(id.toLowerCase())) id = `${id}-${index + 1}`;
    seen.add(id.toLowerCase());
    if (originalId && originalId !== id && !renames.has(originalId)) renames.set(originalId, id);
    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : id;
    stages.push({
      id,
      title,
      description: typeof s.description === 'string' && s.description.trim() ? s.description.trim() : title,
      parent: typeof s.parent === 'string' && s.parent.trim() && !['top', 'none', 'null'].includes(s.parent.trim().toLowerCase())
        ? s.parent.trim()
        : null,
      children: [],
      crosscut,
    });
  });
  // Follow renames, then null dangling parents (sanitizing like stage ids).
  const ids = new Set(stages.map((s) => s.id));
  for (const stage of stages) {
    if (stage.parent !== null) {
      const renamed = renames.get(stage.parent);
      stage.parent = renamed ?? (sanitizeStageId(stage.parent) || null);
    }
    if (stage.parent !== null && (!ids.has(stage.parent) || stage.parent === stage.id)) stage.parent = null;
  }
  // Break multi-node parent CYCLES (A→B→A): walking up from each stage, a
  // repeated id marks a node INSIDE the cycle — detach that node (not the
  // walk's starting stage, which may be an innocent descendant of the cycle).
  for (const stage of stages) {
    const seenUp = new Set<string>([stage.id]);
    let cursor = stage.parent;
    while (cursor !== null) {
      if (seenUp.has(cursor)) {
        const cycleNode = stages.find((s) => s.id === cursor);
        if (cycleNode) cycleNode.parent = null;
        else stage.parent = null;
        break;
      }
      seenUp.add(cursor);
      cursor = stages.find((s) => s.id === cursor)?.parent ?? null;
    }
  }
  for (const stage of stages) {
    if (stage.parent !== null) {
      const parent = stages.find((s) => s.id === stage.parent);
      parent?.children.push(stage.id);
    }
  }
  const metadata = (typeof rawObj.metadata === 'object' && rawObj.metadata !== null ? rawObj.metadata : {}) as Record<string, unknown>;
  return {
    metadata: {
      version: 1,
      archetype: typeof metadata.archetype === 'string' ? metadata.archetype : undefined,
      draftedBy,
    },
    stages,
  };
}

/** One-line stage menu entries for assignment/doctor prompts. */
export function stageShortDescriptions(skeleton: Skeleton): Map<string, string> {
  const menu = new Map<string, string>();
  for (const stage of skeleton.stages) {
    const sentence = stage.description.split(/(?<=\.)\s|。/)[0] ?? stage.description;
    menu.set(stage.id, `${stage.title}: ${sentence}`);
  }
  return menu;
}

export async function synthesizeSkeleton(
  client: ChatClient,
  nav: NavPack,
  cards: Record<string, FileCard>,
  lang: NarrateLang = 'en',
): Promise<Skeleton> {
  const prompt = buildSynthPrompt(nav, dirRollups(cards), lang);
  const response = await client.complete(prompt, { temperature: 0 });
  const skeleton = normalizeSkeleton(response.json);
  if (skeleton.stages.length === 0) {
    throw new Error('skeleton synthesis returned no usable stages');
  }
  return skeleton;
}

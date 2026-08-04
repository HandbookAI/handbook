/**
 * The handbook domain model: everything phases 2–3 produce and the renderer,
 * skill packager, planner and resync consume.
 *
 * All artifacts are persisted as JSON/YAML in the work directory and validated
 * with the schemas below on read, so any pipeline phase can be re-run
 * independently and corrupted artifacts fail loudly instead of propagating.
 */
import { z } from 'zod';

/** Narration language for all handbook-bound prose. */
export const NARRATE_LANGS = ['en', 'zh'] as const;
export type NarrateLang = (typeof NARRATE_LANGS)[number];

/** Constrained role vocabulary for a source file. Invalid answers coerce to `other`. */
export const FILE_ROLES = [
  'entrypoint',
  'orchestration',
  'domain_logic',
  'io_transport',
  'data_model',
  'config',
  'util',
  'test',
  'generated',
  'other',
] as const;
export type FileRole = (typeof FILE_ROLES)[number];

/** Coerce an arbitrary string to a valid {@link FileRole}. */
export function coerceRole(value: unknown): FileRole {
  return typeof value === 'string' && (FILE_ROLES as readonly string[]).includes(value)
    ? (value as FileRole)
    : 'other';
}

/**
 * Per-function annotation on a file card. The structural fields come from the
 * call graph (facts); the prose fields come from the LLM (best-effort, may be
 * empty). The inventory is always complete even when prose is missing.
 */
export const functionNoteSchema = z.object({
  id: z.string(),
  qualname: z.string(),
  name: z.string(),
  className: z.string().nullable(),
  lineRange: z.tuple([z.number().int(), z.number().int()]),
  signature: z.string(),
  /** Internal callees (node ids, capped). */
  calls: z.array(z.string()),
  /** Internal callers (node ids, capped). */
  calledBy: z.array(z.string()),
  /** External callees (qualnames, capped). */
  extCalls: z.array(z.string()),
  nCalls: z.number().int(),
  nCalledBy: z.number().int(),
  nExtCalls: z.number().int(),
  purpose: z.string(),
  dataFlow: z.string(),
  relations: z.string(),
});
export type FunctionNote = z.infer<typeof functionNoteSchema>;

/**
 * One card per source file — the handbook's leaf content for that file.
 * Written to `<work>/phase2/cards/<rel-path>.json`.
 * Brief cards carry only purpose/role/lifecycle; deep cards add a
 * 120–300-word description plus per-function notes.
 */
export const fileCardSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  /** 1–2 plain-language sentences; empty when generation failed (backfilled). */
  purpose: z.string(),
  role: z.enum(FILE_ROLES),
  /** Short lifecycle hint: "startup", "main loop", "cross-cutting", "none", … */
  lifecycle: z.string(),
  description: z.string().optional(),
  functions: z.array(functionNoteSchema).optional(),
});
export type FileCard = z.infer<typeof fileCardSchema>;

/** Coverage record for the cards pass — `cards/_coverage.json`. */
export const cardCoverageSchema = z.object({
  nFiles: z.number().int(),
  nDescribed: z.number().int(),
  missing: z.array(z.string()),
});
export type CardCoverage = z.infer<typeof cardCoverageSchema>;

/** One stage of the handbook skeleton (the narrative spine). */
export const stageSchema = z.object({
  /**
   * Stable id, conventionally `stage-N` / `stage-N.M` / `crosscut-N`.
   * Restricted to filename-safe characters — stage ids become page filenames,
   * so `/` or `..` would let bad input write outside the output directory.
   */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  title: z.string(),
  description: z.string(),
  parent: z.string().nullable(),
  children: z.array(z.string()),
  /** True for cross-cutting infrastructure (config, logging, shared types…). */
  crosscut: z.boolean(),
});
export type Stage = z.infer<typeof stageSchema>;

/** The stage skeleton — `<work>/phase2/skeleton.yaml`. */
export const skeletonSchema = z.object({
  metadata: z.object({
    version: z.literal(1),
    /** One-phrase system archetype, e.g. "terminal coding agent". */
    archetype: z.string().optional(),
    draftedBy: z.string().optional(),
  }),
  stages: z.array(stageSchema),
});
export type Skeleton = z.infer<typeof skeletonSchema>;

/** File → stage assignment — `<work>/phase2/assignment.json`. */
export const assignmentSchema = z.object({
  version: z.literal(1),
  /** Primary stage per file (`unassigned` allowed), plus optional extra stages. */
  fileStage: z.record(z.string(), z.object({ stage: z.string(), also: z.array(z.string()) })),
  /** Stage id → files whose PRIMARY stage it is. Disjoint by construction. */
  buckets: z.record(z.string(), z.array(z.string())),
  coverage: z.object({
    nFiles: z.number().int(),
    nAssigned: z.number().int(),
    unassigned: z.array(z.string()),
  }),
});
export type Assignment = z.infer<typeof assignmentSchema>;

/** A file entry inside an organized sub-group. */
export const organizedFileSchema = z.object({
  file: z.string(),
  purpose: z.string(),
  role: z.enum(FILE_ROLES),
  nFunctions: z.number().int(),
});
export type OrganizedFile = z.infer<typeof organizedFileSchema>;

/** Intra-stage organization — `<work>/phase2/organization.yaml`. */
export const organizationSchema = z.object({
  metadata: z.object({ version: z.literal(1), nStages: z.number().int() }),
  stages: z.record(
    z.string(),
    z.object({
      title: z.string(),
      groups: z.array(
        z.object({ title: z.string(), summary: z.string(), files: z.array(organizedFileSchema) }),
      ),
      /** Flat reading order across groups. */
      orderedFiles: z.array(z.string()),
    }),
  ),
  coverage: z.object({ nFiles: z.number().int(), nOrganized: z.number().int() }),
});
export type Organization = z.infer<typeof organizationSchema>;

/** One cross-stage state register. */
export const registerEntrySchema = z.object({
  /** Stable id, `reg-` + lowercase-hyphen words. */
  id: z.string().regex(/^reg-[a-z0-9-]+$/),
  /** One-line plain-language semantics. */
  semantics: z.string(),
  /** Stage ids that read/write this state. Only real stage ids. */
  stages: z.array(z.string()),
});
export type RegisterEntry = z.infer<typeof registerEntrySchema>;

/** Registers artifact — `<work>/phase3/registers.json`. */
export const registersSchema = z.object({
  version: z.literal(1),
  registers: z.array(registerEntrySchema),
});
export type Registers = z.infer<typeof registersSchema>;

/** Narration artifact — `<work>/phase3/narration.json`. */
export const narrationSchema = z.object({
  version: z.literal(1),
  /** Narration language the prose was written in. */
  lang: z.enum(NARRATE_LANGS),
  /** System-level overview prose (200–350 words). */
  systemOverview: z.string(),
  /** Stage id → 100–200-word overview prose. */
  stageSummaries: z.record(z.string(), z.string()),
});
export type Narration = z.infer<typeof narrationSchema>;

/**
 * Everything the renderer needs, loaded from a completed work directory.
 * This is the boundary type between generation (pipeline) and presentation
 * (renderer / skill): renderer never reads pipeline internals.
 */
export interface HandbookModel {
  title: string;
  lang: NarrateLang;
  skeleton: Skeleton;
  cards: Record<string, FileCard>;
  assignment: Assignment;
  organization: Organization;
  narration: Narration;
  registers: RegisterEntry[];
}

/** Stage lookup helpers shared by pipeline and renderer. */
export class StageTree {
  readonly byId: ReadonlyMap<string, Stage>;
  /** Stage ids in skeleton (lifecycle) order. */
  readonly order: readonly string[];
  /** Parentless stage ids in skeleton order. */
  readonly topLevel: readonly string[];
  private readonly childrenOf: ReadonlyMap<string, readonly string[]>;

  constructor(skeleton: Skeleton) {
    const byId = new Map<string, Stage>();
    for (const stage of skeleton.stages) byId.set(stage.id, stage);
    // Re-derive children from `parent` — robust to stale `children` lists.
    const children = new Map<string, string[]>();
    for (const stage of skeleton.stages) {
      if (stage.parent !== null && byId.has(stage.parent)) {
        const list = children.get(stage.parent) ?? [];
        list.push(stage.id);
        children.set(stage.parent, list);
      }
    }
    this.byId = byId;
    this.order = skeleton.stages.map((s) => s.id);
    this.topLevel = skeleton.stages.filter((s) => s.parent === null || !byId.has(s.parent)).map((s) => s.id);
    this.childrenOf = children;
  }

  title(id: string): string {
    return this.byId.get(id)?.title ?? id;
  }

  description(id: string): string {
    return this.byId.get(id)?.description ?? '';
  }

  isCrosscut(id: string): boolean {
    return this.byId.get(id)?.crosscut ?? false;
  }

  children(id: string): readonly string[] {
    return this.childrenOf.get(id) ?? [];
  }

  /** Depth of a stage (top-level = 0, unreachable parents treated as roots). */
  depth(id: string): number {
    let depth = 0;
    let current = this.byId.get(id);
    const seen = new Set<string>([id]);
    while (current && current.parent !== null && this.byId.has(current.parent) && !seen.has(current.parent)) {
      seen.add(current.parent);
      current = this.byId.get(current.parent);
      depth += 1;
    }
    return depth;
  }

  /** The stage id plus all of its descendants, in skeleton order. Cycle-safe. */
  subtree(id: string): string[] {
    // Iterative (explicit stack): a deep parent chain in a corrupted skeleton
    // would overflow a recursive walk. The `keep` set still guards cycles.
    const keep = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const sid = stack.pop() as string;
      if (keep.has(sid)) continue; // already visited (or a parent cycle)
      keep.add(sid);
      for (const child of this.children(sid)) stack.push(child);
    }
    return this.order.filter((sid) => keep.has(sid));
  }
}

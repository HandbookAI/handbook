/**
 * Internal view helpers shared by the markdown, agent-site and HTML renderers.
 *
 * Wraps a {@link HandbookModel} with the derived lookups every renderer needs:
 * content gating (a stage gets a page iff it has children or direct files),
 * organization-ordered file lists, subtree file counts and summary fallbacks.
 */
import { StageTree } from '@handbook/core';
import type { AdapterCapabilities, FileCard, HandbookModel, RegisterEntry } from '@handbook/core';

/** One organization group resolved against the stage's actual bucket. */
export interface ResolvedGroup {
  title: string;
  summary: string;
  files: string[];
}

export class HandbookView {
  readonly tree: StageTree;

  constructor(readonly model: HandbookModel) {
    this.tree = new StageTree(model.skeleton);
  }

  /** Files whose PRIMARY stage is `sid`, in organization reading order. */
  directFiles(sid: string): string[] {
    const bucket = this.model.assignment.buckets[sid] ?? [];
    const ordered = this.model.organization.stages[sid]?.orderedFiles ?? [];
    const rank = new Map(ordered.map((f, i) => [f, i]));
    return [...bucket].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
  }

  /** Content rule: a stage gets a page/summary iff it has children or direct files. */
  hasContent(sid: string): boolean {
    return this.tree.children(sid).length > 0 || (this.model.assignment.buckets[sid] ?? []).length > 0;
  }

  /** All content-bearing stage ids in skeleton order. */
  contentStages(): string[] {
    return this.tree.order.filter((sid) => this.hasContent(sid));
  }

  /** Content-bearing children of a stage. */
  contentChildren(sid: string): string[] {
    return this.tree.children(sid).filter((child) => this.hasContent(child));
  }

  /** Content-bearing top-level roots. */
  contentRoots(): string[] {
    return this.tree.topLevel.filter((sid) => this.hasContent(sid));
  }

  /** Total files in a stage's subtree (bucket sizes summed). */
  subtreeFileCount(sid: string): number {
    return this.tree
      .subtree(sid)
      .reduce((sum, s) => sum + (this.model.assignment.buckets[s] ?? []).length, 0);
  }

  /** Stage summary prose: narration, falling back to description, then title. */
  summary(sid: string): string {
    const narrated = this.model.narration.stageSummaries[sid];
    if (narrated && narrated.trim().length > 0) return narrated.trim();
    const description = this.tree.description(sid);
    return description.trim().length > 0 ? description.trim() : this.tree.title(sid);
  }

  /** Card for a file, with a defensive stub when the card is missing. */
  card(rel: string): FileCard {
    return (
      this.model.cards[rel] ?? { version: 1, file: rel, purpose: '', role: 'other', lifecycle: 'none' }
    );
  }

  /**
   * Organization groups for a stage, filtered to the actual bucket, plus the
   * defensive leftovers (bucket files no group claimed) as a second value.
   */
  groups(sid: string): { groups: ResolvedGroup[]; leftovers: string[] } {
    const bucket = new Set(this.model.assignment.buckets[sid] ?? []);
    const raw = this.model.organization.stages[sid]?.groups ?? [];
    const claimed = new Set<string>();
    const groups: ResolvedGroup[] = [];
    for (const group of raw) {
      const files = group.files.map((f) => f.file).filter((f) => bucket.has(f) && !claimed.has(f));
      for (const f of files) claimed.add(f);
      if (files.length > 0) groups.push({ title: group.title, summary: group.summary, files });
    }
    const leftovers = this.directFiles(sid).filter((f) => !claimed.has(f));
    return { groups, leftovers };
  }

  /** file → owning stage over ALL buckets. */
  fileStageIndex(): Map<string, string> {
    const index = new Map<string, string>();
    for (const [sid, files] of Object.entries(this.model.assignment.buckets)) {
      for (const file of files) index.set(file, sid);
    }
    return index;
  }

  /** Registers whose extraction placed them directly on `sid`. */
  directRegisters(sid: string): RegisterEntry[] {
    return this.model.registers.filter((reg) => reg.stages.includes(sid));
  }

  /** Ancestor stage ids of `sid` (nearest first). */
  ancestors(sid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([sid]);
    let current = this.tree.byId.get(sid);
    while (current && current.parent !== null && this.tree.byId.has(current.parent) && !seen.has(current.parent)) {
      out.push(current.parent);
      seen.add(current.parent);
      current = this.tree.byId.get(current.parent);
    }
    return out;
  }
}

/** Options accepted by renderers that can hyperlink file-card paths to sources. */
export interface SourceLinkOptions {
  /**
   * Base URL each file card's repo-relative path is joined onto (e.g. a
   * forge blob URL). When absent, file paths render as plain text and the
   * output stays free of external URLs.
   */
  sourceBaseUrl?: string;
}

/** Options for renderers that can disclose how the call facts were obtained. */
export interface FidelityOptions {
  /**
   * `graph.metadata.languages` — language name → what its adapter can deliver.
   * The handbook model deliberately does not carry graph metadata, so this
   * arrives as a render option; omit it and the output says nothing about
   * fidelity (which is also what every pre-existing graph.json supports).
   */
  languages?: Record<string, AdapterCapabilities>;
}

/** Everything the markdown and multi-page HTML renderers accept. */
export interface RenderOptions extends SourceLinkOptions, FidelityOptions {}

/**
 * Contributing languages analyzed by the generic (config-driven) engine, sorted.
 *
 * Only these need disclosing: a full-tier language's call facts are as hard as
 * the analyzer gets, so naming it would be noise. Empty = say nothing at all.
 */
export function genericTierLanguages(languages: FidelityOptions['languages']): string[] {
  return Object.entries(languages ?? {})
    .filter(([, capabilities]) => capabilities.tier === 'generic')
    .map(([name]) => name)
    .sort();
}

/**
 * Join a source base URL and a repo-relative path: trailing `/` stripped from
 * the base, path segments URL-encoded, `/` separators kept.
 */
export function sourceFileUrl(baseUrl: string, rel: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Fenced `flowchart TD` mermaid diagram of the stage tree (parent→child edges,
 * titles as labels, crosscut stages styled). Stage ids may contain dots, which
 * mermaid node ids cannot — dots map to `_` (collisions get `_` suffixes).
 * Returns '' when the skeleton has fewer than two stages: a one-node diagram
 * carries no information.
 */
export function stageMapMermaid(tree: StageTree): string {
  if (tree.order.length < 2) return '';
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const sid of tree.order) {
    let mid = sid.replace(/\./g, '_');
    while (taken.has(mid)) mid = `${mid}_`;
    taken.add(mid);
    ids.set(sid, mid);
  }
  const lines: string[] = ['flowchart TD'];
  let hasCrosscut = false;
  for (const sid of tree.order) {
    // A mermaid node label is single-line: any raw newline (or other line
    // separator) inside `["…"]` splits the statement and breaks the whole
    // diagram, so flatten every whitespace run to one space before escaping
    // quotes. Fall back to the id when the title is blank/whitespace-only, so
    // we never emit an empty-label node.
    const label = (tree.title(sid).replace(/\s+/g, ' ').trim() || sid).replace(/"/g, '#quot;');
    const crosscut = tree.isCrosscut(sid);
    hasCrosscut = hasCrosscut || crosscut;
    lines.push(`  ${ids.get(sid)}["${label}"]${crosscut ? ':::crosscut' : ''}`);
  }
  for (const sid of tree.order) {
    for (const child of tree.children(sid)) lines.push(`  ${ids.get(sid)} --> ${ids.get(child)}`);
  }
  if (hasCrosscut) lines.push('  classDef crosscut stroke-dasharray: 5 5;');
  return ['```mermaid', ...lines, '```'].join('\n');
}

/**
 * Escape a value used as markdown LINK TEXT (`[<here>](url)`): flatten
 * whitespace to single spaces and backslash-escape brackets. LLM/codebase
 * titles routinely contain brackets (`Query [beta]`, a stray `foo]`); an
 * unbalanced `]`/`[` terminates the link early — dead-ending the internal
 * navigation link — or lets a `](evil)` sequence forge a second link. Escaping
 * keeps the bracket literal so the intended link always survives.
 */
export function mdLinkText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');
}

/** POSIX basename without its final extension. */
export function fileStem(rel: string): string {
  const base = rel.split('/').pop() ?? rel;
  return base.replace(/\.[^.]+$/, '');
}

/** POSIX dirname ('' for top-level files). */
export function fileDir(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

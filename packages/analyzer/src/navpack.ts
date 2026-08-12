/**
 * The navigation pack: a deterministic, graph-derived orientation summary of
 * the codebase (directory map, entry points, fan-out, external subsystems).
 * It feeds skeleton synthesis and file assignment — no LLM involved.
 */
import type { CodeGraph } from '@handbooks/core';
import { isInternalNode, truncate } from '@handbooks/core';

export interface NavFileDescriptor {
  file: string;
  dir: string;
  nFunctions: number;
  classes: string[];
  sampleFunctions: Array<{ qualname: string; signature: string; lineStart: number }>;
}

export interface NavPack {
  language: string;
  sourceRoot: string;
  totals: { nFiles: number; nFunctions: number; nDirs: number; nExternalSubsystems: number };
  dirMap: Record<string, { nFiles: number; nFunctions: number }>;
  files: NavFileDescriptor[];
  entryPoints: Array<{
    qualname: string;
    file: string;
    lineStart: number;
    nCallees: number;
    isRoot: boolean;
  }>;
  fanOutTop: Array<{ file: string; outDegree: number }>;
  externalSubsystems: Array<{ module: string; nCallsInto: number; sample: string[] }>;
}

const ENTRY_HINTS = [
  'main',
  'run',
  'serve',
  'start',
  'execute',
  'exec',
  'dispatch',
  'handle',
  'handler',
  'cmd',
  'command',
  'app',
  'loop',
  'bootstrap',
];

function dirOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i < 0 ? '.' : file.slice(0, i);
}

export interface NavPackOptions {
  fanOutTopK?: number;
  sampleFnsPerFile?: number;
}

export function buildNavPack(graph: CodeGraph, options: NavPackOptions = {}): NavPack {
  const fanOutTopK = options.fanOutTopK ?? 40;
  const samplePerFile = options.sampleFnsPerFile ?? 8;

  const internal = Object.values(graph.nodes).filter((n) => isInternalNode(n) && !n.synthetic) as Array<
    Extract<(typeof graph.nodes)[string], { kind: 'internal' }>
  >;

  const byFile = new Map<string, typeof internal>();
  for (const node of internal) {
    const list = byFile.get(node.file) ?? [];
    list.push(node);
    byFile.set(node.file, list);
  }

  const dirMap: NavPack['dirMap'] = {};
  for (const [file, fns] of byFile) {
    const dir = dirOf(file);
    const entry = (dirMap[dir] ??= { nFiles: 0, nFunctions: 0 });
    entry.nFiles += 1;
    entry.nFunctions += fns.length;
  }

  const files: NavFileDescriptor[] = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, fns]) => ({
      file,
      dir: dirOf(file),
      nFunctions: fns.length,
      classes: [...new Set(fns.map((f) => f.className).filter((c): c is string => !!c))].sort(),
      sampleFunctions: fns
        .slice()
        .sort((a, b) => a.lineStart - b.lineStart)
        .slice(0, samplePerFile)
        .map((f) => ({
          qualname: f.qualname,
          signature: truncate(f.signature, 120),
          lineStart: f.lineStart,
        })),
    }));

  // Entry points: roots (no internal callers) ∪ name-heuristic hits.
  // Keyed by node id — distinct `main`s in different files must all survive.
  const entries = new Map<string, NavPack['entryPoints'][number]>();
  for (const node of internal) {
    if (node.lineStart <= 0) continue;
    const isRoot = node.nCallers === 0;
    const isHint = ENTRY_HINTS.some((h) => node.name === h || node.name.startsWith(`${h}_`));
    if (!isRoot && !isHint) continue;
    if (!entries.has(node.id)) {
      entries.set(node.id, {
        qualname: node.qualname,
        file: node.file,
        lineStart: node.lineStart,
        nCallees: node.nCallees,
        isRoot,
      });
    }
  }
  const entryPoints = [...entries.values()].sort(
    (a, b) => b.nCallees - a.nCallees || a.qualname.localeCompare(b.qualname),
  );

  const fanOut = [...byFile.entries()]
    .map(([file, fns]) => ({ file, outDegree: fns.reduce((sum, f) => sum + f.nCallees, 0) }))
    .sort((a, b) => b.outDegree - a.outDegree)
    .slice(0, fanOutTopK);

  // External subsystems: boundary callees grouped by first module segment.
  const external = new Map<string, { nCallsInto: number; sample: Set<string> }>();
  for (const edge of graph.edges) {
    if (!edge.calleeId.startsWith('boundary:')) continue;
    const qual = edge.calleeId.slice('boundary:'.length);
    // `./x.js::Engine.run` → `./x.js`; `node:fs.readFileSync` → `node:fs`;
    // `Wheel.turn` → `Wheel`. Never an empty key (relative specifiers start with a dot).
    const sep = qual.indexOf('::');
    const moduleName = sep >= 0 ? qual.slice(0, sep) : (qual.split('.', 1)[0] ?? qual) || qual;
    const entry = external.get(moduleName) ?? { nCallsInto: 0, sample: new Set<string>() };
    entry.nCallsInto += 1;
    if (entry.sample.size < 5) entry.sample.add(qual);
    external.set(moduleName, entry);
  }
  const externalSubsystems = [...external.entries()]
    .map(([module, e]) => ({ module, nCallsInto: e.nCallsInto, sample: [...e.sample] }))
    .sort((a, b) => b.nCallsInto - a.nCallsInto);

  return {
    language: graph.metadata.language,
    sourceRoot: graph.metadata.sourceRoot,
    totals: {
      nFiles: byFile.size,
      nFunctions: internal.length,
      nDirs: Object.keys(dirMap).length,
      nExternalSubsystems: externalSubsystems.length,
    },
    dirMap: Object.fromEntries(Object.entries(dirMap).sort(([a], [b]) => a.localeCompare(b))),
    files,
    entryPoints,
    fanOutTop: fanOut,
    externalSubsystems,
  };
}

/**
 * Widen nav files with scanned files that have no functions — the 1:1 file set
 * used by the cards pass and file assignment (nothing silently dropped).
 */
export function allFileDescriptors(graph: CodeGraph, nav: NavPack): NavFileDescriptor[] {
  const known = new Set(nav.files.map((f) => f.file));
  const extra = graph.metadata.scannedFiles
    .filter((f) => !known.has(f))
    .map((file) => ({ file, dir: dirOf(file), nFunctions: 0, classes: [], sampleFunctions: [] }));
  return [...nav.files, ...extra].sort((a, b) => a.file.localeCompare(b.file));
}

export interface OrientationOptions {
  maxDirs?: number;
  maxEntries?: number;
  maxExternal?: number;
}

/** Bounded plain-text orientation block for prompts and agent tools. */
export function renderOrientation(nav: NavPack, options: OrientationOptions = {}): string {
  const maxDirs = options.maxDirs ?? 120;
  const maxEntries = options.maxEntries ?? 25;
  const maxExternal = options.maxExternal ?? 30;
  const lines: string[] = [];
  lines.push(
    `SYSTEM: language=${nav.language} files=${nav.totals.nFiles} functions=${nav.totals.nFunctions} dirs=${nav.totals.nDirs}`,
  );
  lines.push('', '## Directory map');
  for (const [dir, info] of Object.entries(nav.dirMap).slice(0, maxDirs)) {
    lines.push(`- ${dir}  (${info.nFiles} files, ${info.nFunctions} fns)`);
  }
  lines.push('', '## Entry-point candidates');
  for (const e of nav.entryPoints.slice(0, maxEntries)) {
    lines.push(
      `- [${e.isRoot ? 'root' : 'hint'}] ${e.qualname}  ${e.file}:${e.lineStart}  →${e.nCallees} callees`,
    );
  }
  lines.push('', '## Highest fan-out files');
  for (const f of nav.fanOutTop.slice(0, 15)) {
    lines.push(`- ${f.file}  out-degree ${f.outDegree}`);
  }
  lines.push('', '## External subsystems');
  for (const s of nav.externalSubsystems.slice(0, maxExternal)) {
    lines.push(`- ${s.module}  (${s.nCallsInto} calls; e.g. ${s.sample.slice(0, 3).join(', ')})`);
  }
  return lines.join('\n');
}

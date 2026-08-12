/**
 * Assemble a {@link CodeGraph} from adapter output and emit the five phase-1
 * artifacts: `graph.json`, `functions.csv`, `graph.dot`, `dropped-calls.json`
 * and `scan-coverage.json`.
 *
 * Identical across languages: adapters decide WHAT the nodes/edges are, this
 * module decides how they become a persisted graph.
 */
import { join } from 'node:path';
import type {
  BoundaryNode,
  CallEdge,
  CodeGraph,
  DroppedCalls,
  FunctionNode,
  GraphNode,
  ModuleAnalysis,
  ScanCoverage,
  SelfAttrsIndex,
  TypeNode,
  UnparsedFile,
} from '@handbooks/core';
import { writeFileAtomic, writeJsonFile } from '@handbooks/core';

export interface BuildGraphOptions {
  sourceRoot: string;
  scannedFiles: readonly string[];
  /** sha256 per scanned file (in-place edit detection for resync). */
  fileHashes?: Record<string, string>;
  /** Language label for metadata (`multi` for merged graphs). */
  language: string;
  /**
   * Which adapter scanned each file — relative POSIX path → language name.
   *
   * Optional because a single-language caller can leave it out and lose
   * nothing; a polyglot one must pass it, or fidelity can only be disclosed as
   * a global footnote rather than on the rows it governs.
   */
  fileLanguages?: Readonly<Record<string, string>>;
  /**
   * Files the analysis could not fully turn into facts. Pass `[]` to state that
   * every scanned file parsed cleanly; omit it only when the caller genuinely
   * does not know (an out-of-tree adapter that predates the record).
   */
  unparsedFiles?: readonly UnparsedFile[];
  /**
   * Extension used to synthesize file names of implicit nodes (e.g. an implied
   * constructor). Pass the analyzed language's extension; empty (default)
   * leaves the fabricated path extension-less.
   */
  defaultExt?: string;
  now?: Date;
}

export interface BuildGraphResult {
  graph: CodeGraph;
  dropped: DroppedCalls;
  scanCoverage: ScanCoverage;
  stats: {
    functions: number;
    edgesKept: number;
    edgesDropped: number;
    internalNodes: number;
    boundaryNodes: number;
    /** Parsed type declarations, or undefined when no adapter looked for any. */
    types?: number;
    /** Files recorded as unreadable, unparsable or partially parsed. */
    filesUnparsed: number;
  };
}

const POLICY =
  'Edges are emitted only when the callee resolves to a named function (internal or boundary). ' +
  'Unresolved/builtin calls live in dropped-calls.json.';

export function buildGraph(analysis: ModuleAnalysis, options: BuildGraphOptions): BuildGraphResult {
  const kept: CallEdge[] = [];
  const droppedEdges: CallEdge[] = [];
  for (const edge of analysis.edges) {
    (edge.callType === 'unresolved' ? droppedEdges : kept).push(edge);
  }

  const nodes = buildNodeTable(analysis.functions, kept, options.defaultExt ?? '');
  const selfAttrs = buildSelfAttrsIndex(analysis.functions);
  const generatedAt = (options.now ?? new Date()).toISOString();

  const internalCount = Object.values(nodes).filter((n) => n.kind === 'internal').length;
  const boundaryCount = Object.values(nodes).filter((n) => n.kind === 'boundary').length;
  const types = analysis.types ? sortTypes(analysis.types) : undefined;

  const graph: CodeGraph = {
    version: 1,
    metadata: {
      generatedAt,
      language: options.language,
      sourceRoot: options.sourceRoot,
      scannedFiles: [...options.scannedFiles],
      fileHashes: options.fileHashes,
      // Sorted, so an unchanged tree re-renders byte-identically — the same rule
      // every other map in this artifact follows.
      fileLanguages: options.fileLanguages
        ? Object.fromEntries(Object.entries(options.fileLanguages).sort(([a], [b]) => (a < b ? -1 : 1)))
        : undefined,
      nInternalFunctions: internalCount,
      nBoundaryNodes: boundaryCount,
      nEdges: kept.length,
      nTypes: types?.length,
      policy: POLICY,
      unparsedFiles: options.unparsedFiles ? [...options.unparsedFiles] : undefined,
    },
    nodes,
    edges: kept,
    selfAttrs,
    // Passed straight through, not derived: a type is a parser fact and this
    // builder's job is assembly. Undefined stays undefined — see
    // {@link ModuleAnalysis.types} for why an absent array and an empty one are
    // different statements.
    types,
  };

  const unparsed = options.unparsedFiles ?? [];
  return {
    graph,
    dropped: buildDroppedCalls(droppedEdges, generatedAt),
    scanCoverage: buildScanCoverage(unparsed, options.scannedFiles.length, generatedAt),
    stats: {
      functions: analysis.functions.length,
      edgesKept: kept.length,
      edgesDropped: droppedEdges.length,
      internalNodes: internalCount,
      boundaryNodes: boundaryCount,
      types: types?.length,
      filesUnparsed: unparsed.length,
    },
  };
}

/**
 * Sort types by `(file, lineStart, name)`.
 *
 * Adapters are driven one language at a time and `discoverAll`'s iteration order
 * is nobody's promise, so without this a multi-language run over an unchanged
 * tree could reorder the array and produce a different `graph.json`. Same reason
 * `scan-coverage.json` sorts its file list. Byte-wise on the strings, never
 * `localeCompare`, so the order does not depend on the developer's machine.
 */
function sortTypes(types: readonly TypeNode[]): TypeNode[] {
  const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...types].sort(
    (a, b) => byBytes(a.file, b.file) || a.lineStart - b.lineStart || byBytes(a.name, b.name),
  );
}

function buildNodeTable(
  functions: readonly FunctionNode[],
  keptEdges: readonly CallEdge[],
  defaultExt: string,
): Record<string, GraphNode> {
  const nodes: Record<string, GraphNode> = {};
  for (const fn of functions) {
    nodes[fn.id] = { ...fn, nCallees: 0, nCallers: 0 };
  }

  // Synthesize nodes referenced by edges but never defined in source.
  for (const edge of keptEdges) {
    for (const id of [edge.callerId, edge.calleeId]) {
      if (nodes[id]) continue;
      if (id.startsWith('boundary:')) {
        nodes[id] = { ...synthesizeBoundary(id), nCallees: 0, nCallers: 0 };
      } else if (/[.:]__init__$|[.:]new$/.test(id) || edge.callType === 'internal_constructor') {
        nodes[id] = { ...synthesizeConstructor(id, defaultExt), nCallees: 0, nCallers: 0 };
      } else {
        // Defensive: an internal edge endpoint the adapter forgot to define.
        nodes[id] = { ...synthesizeConstructor(id, defaultExt), nCallees: 0, nCallers: 0 };
      }
    }
  }

  for (const edge of keptEdges) {
    const caller = nodes[edge.callerId];
    const callee = nodes[edge.calleeId];
    if (caller) caller.nCallees += 1;
    if (callee) callee.nCallers += 1;
  }
  return nodes;
}

/** `boundary:pkg.mod.Class.method` → BoundaryNode with a best-effort class split. */
export function synthesizeBoundary(id: string): BoundaryNode {
  const qualname = id.slice('boundary:'.length);
  const segments = qualname.split(/[.:]+/).filter(Boolean);
  const name = segments.at(-1) ?? qualname;
  // First segment starting uppercase becomes the class; everything before is the module.
  const classIndex = segments.findIndex((s) => /^[A-Z]/.test(s));
  const className = classIndex >= 0 && classIndex < segments.length - 1 ? (segments[classIndex] ?? '') : '';
  const moduleEnd = classIndex >= 0 ? classIndex : segments.length - 1;
  return {
    id,
    name,
    qualname,
    module: segments.slice(0, moduleEnd).join('.'),
    className,
    kind: 'boundary',
  };
}

function synthesizeConstructor(id: string, defaultExt: string): FunctionNode {
  const sep = id.includes('::') ? '::' : '.';
  const segments = id.split(sep);
  const name = segments.at(-1) ?? id;
  const className = segments.length >= 2 ? (segments.at(-2) ?? null) : null;
  const moduleId = segments.slice(0, Math.max(1, segments.length - 2)).join(sep);
  return {
    id,
    name,
    qualname: className ? `${className}${sep}${name}` : name,
    file: `${moduleId.split(sep).join('/')}${defaultExt}`,
    lineStart: 0,
    lineEnd: 0,
    signature: `${name}(...)  (synthesized — no explicit definition in source)`,
    isAsync: false,
    isMethod: className !== null,
    className,
    decorators: [],
    kind: 'internal',
    synthetic: true,
    selfAttrsRead: [],
    selfAttrsWritten: [],
    paramTypes: {},
  };
}

function buildSelfAttrsIndex(functions: readonly FunctionNode[]): SelfAttrsIndex {
  // Accumulate into insertion-ordered Sets, then materialize arrays. A Set
  // dedups defensively (a caller may pass same-id functions) in O(1); the old
  // `Array.includes` guard was O(n) per push — quadratic for a class with
  // thousands of methods touching the same attribute. Set iteration preserves
  // insertion order, so the emitted arrays and JSON key order are unchanged.
  const acc = new Map<string, Map<string, { readIn: Set<string>; writtenIn: Set<string> }>>();
  for (const fn of functions) {
    if (!fn.className) continue;
    let byClass = acc.get(fn.className);
    if (!byClass) {
      byClass = new Map();
      acc.set(fn.className, byClass);
    }
    for (const [attrs, key] of [
      [fn.selfAttrsRead, 'readIn'],
      [fn.selfAttrsWritten, 'writtenIn'],
    ] as const) {
      for (const attr of attrs) {
        let entry = byClass.get(attr);
        if (!entry) {
          entry = { readIn: new Set(), writtenIn: new Set() };
          byClass.set(attr, entry);
        }
        entry[key].add(fn.id);
      }
    }
  }
  const index: SelfAttrsIndex = {};
  for (const [className, byClass] of acc) {
    const outClass: SelfAttrsIndex[string] = {};
    index[className] = outClass;
    for (const [attr, entry] of byClass) {
      outClass[attr] = { readIn: [...entry.readIn], writtenIn: [...entry.writtenIn] };
    }
  }
  return index;
}

/** Built-in-ish callee names that are noise rather than missing resolution. */
const BUILTIN_NAMES = new Set([
  'len',
  'isinstance',
  'print',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'range',
  'enumerate',
  'zip',
  'map',
  'filter',
  'sorted',
  'min',
  'max',
  'sum',
  'abs',
  'open',
  'repr',
  'hasattr',
  'getattr',
  'setattr',
  'super',
  'type',
  'vars',
  'iter',
  'next',
  'format',
  'ValueError',
  'TypeError',
  'KeyError',
  'RuntimeError',
  'Exception',
  'StopIteration',
  'NotImplementedError',
  'FileNotFoundError',
  'OSError',
  'IndexError',
  'AttributeError',
]);

export function categorizeDropped(calleeId: string): string {
  const hint = calleeId.startsWith('unresolved:') ? calleeId.slice('unresolved:'.length) : calleeId;
  if (/^self\._?logger\./.test(hint)) return 'inherited_method';
  if (hint.startsWith('self.') || hint.startsWith('this.')) return 'self_attr_unknown';
  if (hint.startsWith('"') || hint.startsWith("'")) return 'string_literal_method';
  const head = hint.split(/[.(]/, 1)[0] ?? hint;
  if (BUILTIN_NAMES.has(head)) return 'builtin';
  if (hint.includes('.')) return 'local_var_method';
  return 'bare_name';
}

function buildDroppedCalls(edges: readonly CallEdge[], generatedAt: string): DroppedCalls {
  const byCategory: Record<string, DroppedCalls['edgesByCategory'][string]> = {};
  for (const edge of edges) {
    const category = categorizeDropped(edge.calleeId);
    (byCategory[category] ??= []).push({
      caller: edge.callerId,
      calleeRaw: edge.calleeId.replace(/^unresolved:/, ''),
      isAwait: edge.isAwait,
      line: edge.line,
      raw: edge.raw,
    });
  }
  return {
    version: 1,
    metadata: {
      generatedAt,
      totalDropped: edges.length,
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
    },
    edgesByCategory: byCategory,
  };
}

function buildScanCoverage(
  unparsed: readonly UnparsedFile[],
  nScanned: number,
  generatedAt: string,
): ScanCoverage {
  const byReason: Record<string, number> = {};
  for (const entry of unparsed) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  return {
    version: 1,
    metadata: { generatedAt, nScanned, nUnparsed: unparsed.length, byReason },
    // Sorted so two runs over an unchanged tree produce a byte-identical file:
    // adapters are driven per language, and `discoverAll`'s iteration order is
    // not a promise anyone made.
    files: [...unparsed].sort((a, b) => a.file.localeCompare(b.file)),
  };
}

/**
 * Emit graph.json / functions.csv / graph.dot / dropped-calls.json /
 * scan-coverage.json into `outDir`.
 */
export function writeGraphArtifacts(result: BuildGraphResult, outDir: string): void {
  writeJsonFile(join(outDir, 'graph.json'), result.graph);
  writeJsonFile(join(outDir, 'dropped-calls.json'), result.dropped);
  writeJsonFile(join(outDir, 'scan-coverage.json'), result.scanCoverage);
  writeFileAtomic(join(outDir, 'functions.csv'), functionsCsv(result.graph));
  writeFileAtomic(join(outDir, 'graph.dot'), graphDot(result.graph));
}

const CSV_HEADER =
  'id,name,qualname,file,line_start,line_end,class,is_async,is_method,decorators,signature,n_callers,n_callees,n_self_attrs_read,n_self_attrs_written';

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function functionsCsv(graph: CodeGraph): string {
  const rows = [CSV_HEADER];
  for (const node of Object.values(graph.nodes)) {
    if (node.kind !== 'internal') continue;
    rows.push(
      [
        node.id,
        node.name,
        node.qualname,
        node.file,
        String(node.lineStart),
        String(node.lineEnd),
        node.className ?? '',
        String(node.isAsync),
        String(node.isMethod),
        node.decorators.join('|'),
        node.signature,
        String(node.nCallers),
        String(node.nCallees),
        String(node.selfAttrsRead.length),
        String(node.selfAttrsWritten.length),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

export function graphDot(graph: CodeGraph): string {
  const lines = ['digraph handbook {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  const byFile = new Map<string, string[]>();
  const boundary: string[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.kind === 'internal') {
      const list = byFile.get(node.file) ?? [];
      list.push(node.id);
      byFile.set(node.file, list);
    } else {
      boundary.push(node.id);
    }
  }
  let cluster = 0;
  const quote = (s: string): string => `"${s.replaceAll('"', '\\"')}"`;
  for (const [file, ids] of byFile) {
    lines.push(`  subgraph cluster_${cluster} {`);
    lines.push(`    label=${quote(file)}; style=dashed; bgcolor="#e8f0fe";`);
    for (const id of ids) lines.push(`    ${quote(id)};`);
    lines.push('  }');
    cluster += 1;
  }
  if (boundary.length > 0) {
    lines.push('  subgraph cluster_boundary {');
    lines.push('    label="boundary"; style=dashed; bgcolor="#f0f0f0";');
    for (const id of boundary) lines.push(`    ${quote(id)};`);
    lines.push('  }');
  }
  for (const edge of graph.edges) {
    const attrs: string[] = [];
    if (edge.isAwait) attrs.push('color="#1a73e8"');
    if (edge.callType === 'boundary' || edge.callType === 'boundary_constructor') attrs.push('style=dashed');
    lines.push(
      `  ${quote(edge.callerId)} -> ${quote(edge.calleeId)}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`,
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

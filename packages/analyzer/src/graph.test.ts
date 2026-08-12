import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallEdge, CallType, FunctionNode, ModuleAnalysis, TypeNode } from '@handbooks/core';
import { codeGraphSchema, scanCoverageSchema } from '@handbooks/core';
import {
  buildGraph,
  categorizeDropped,
  functionsCsv,
  synthesizeBoundary,
  writeGraphArtifacts,
  type BuildGraphOptions,
} from './graph.js';

function fn(id: string, file: string, overrides: Partial<FunctionNode> = {}): FunctionNode {
  const name = id.split('.').at(-1) ?? id;
  return {
    id,
    name,
    qualname: name,
    file,
    lineStart: 1,
    lineEnd: 5,
    signature: `${name}()`,
    isAsync: false,
    isMethod: false,
    className: null,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: [],
    selfAttrsWritten: [],
    paramTypes: {},
    ...overrides,
  };
}

function edge(
  callerId: string,
  calleeId: string,
  callType: CallType,
  overrides: Partial<CallEdge> = {},
): CallEdge {
  return { callerId, calleeId, isAwait: false, callType, line: 3, raw: `${calleeId}(…)`, ...overrides };
}

function options(overrides: Partial<BuildGraphOptions> = {}): BuildGraphOptions {
  return {
    sourceRoot: '/repo/src',
    scannedFiles: ['app/main.py', 'app/engine.py'],
    language: 'python',
    defaultExt: '.py',
    now: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('buildGraph — degree annotation', () => {
  const analysis: ModuleAnalysis = {
    functions: [
      fn('app.main.main', 'app/main.py'),
      fn('app.engine.Engine.spin', 'app/engine.py', {
        qualname: 'Engine.spin',
        className: 'Engine',
        isMethod: true,
        selfAttrsRead: ['rpm'],
        selfAttrsWritten: ['rpm'],
      }),
      fn('app.util.helper', 'app/util.py'),
    ],
    edges: [
      edge('app.main.main', 'app.engine.Engine.spin', 'self_attr_method'),
      edge('app.main.main', 'app.util.helper', 'internal_func'),
      edge('app.engine.Engine.spin', 'app.util.helper', 'internal_func'),
    ],
  };
  const { graph, stats } = buildGraph(analysis, options());

  it('annotates nCallers/nCallees to match the kept edges', () => {
    expect(graph.nodes['app.main.main']).toMatchObject({ nCallees: 2, nCallers: 0 });
    expect(graph.nodes['app.engine.Engine.spin']).toMatchObject({ nCallees: 1, nCallers: 1 });
    expect(graph.nodes['app.util.helper']).toMatchObject({ nCallees: 0, nCallers: 2 });
  });

  it('records metadata counts and stats consistent with the node table', () => {
    expect(graph.metadata.nInternalFunctions).toBe(3);
    expect(graph.metadata.nBoundaryNodes).toBe(0);
    expect(graph.metadata.nEdges).toBe(3);
    expect(graph.metadata.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stats).toEqual({
      functions: 3,
      edgesKept: 3,
      edgesDropped: 0,
      internalNodes: 3,
      boundaryNodes: 0,
      filesUnparsed: 0,
    });
  });

  it('indexes self-attribute reads/writes by class', () => {
    expect(graph.selfAttrs['Engine']?.['rpm']).toEqual({
      readIn: ['app.engine.Engine.spin'],
      writtenIn: ['app.engine.Engine.spin'],
    });
  });

  it('emits only internal nodes into functions.csv, with degree columns', () => {
    const csv = functionsCsv(graph);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 internal nodes
    const helperRow = lines.find((l) => l.startsWith('app.util.helper,'));
    expect(helperRow).toContain(',2,0,'); // n_callers=2, n_callees=0
  });
});

describe('buildGraph — selfAttrs index scale (pass 2)', () => {
  it('builds the self-attr index in ~linear time for a class with many same-attr methods', () => {
    // Pre-fix the per-push `Array.includes` dedup was O(n^2): ~4s at 50k here.
    // Post-fix (insertion-ordered Set) it is ~linear.
    const N = 50000;
    const functions: FunctionNode[] = [];
    for (let i = 0; i < N; i += 1) {
      functions.push(
        fn(`m.C.method${i}`, 'm.py', {
          className: 'C',
          isMethod: true,
          selfAttrsRead: ['shared'],
          selfAttrsWritten: ['shared'],
        }),
      );
    }
    const t0 = Date.now();
    const { graph } = buildGraph({ functions, edges: [] }, options({ scannedFiles: ['m.py'] }));
    const ms = Date.now() - t0;
    const entry = graph.selfAttrs['C']?.['shared'];
    expect(entry?.readIn).toHaveLength(N);
    expect(entry?.writtenIn).toHaveLength(N);
    // insertion order preserved (method0 first, methodN-1 last)
    expect(entry?.readIn[0]).toBe('m.C.method0');
    expect(entry?.readIn.at(-1)).toBe(`m.C.method${N - 1}`);
    expect(ms).toBeLessThan(2000); // pre-fix: ~4s
  });

  it('dedupes duplicate-id functions in the self-attr index (defensive)', () => {
    const dup = fn('m.C.m', 'm.py', { className: 'C', isMethod: true, selfAttrsRead: ['x'] });
    const { graph } = buildGraph(
      { functions: [dup, dup, dup], edges: [] },
      options({ scannedFiles: ['m.py'] }),
    );
    expect(graph.selfAttrs['C']?.['x']?.readIn).toEqual(['m.C.m']); // not repeated 3×
  });
});

describe('buildGraph — synthetic constructor synthesis', () => {
  it('synthesizes an implicit __init__ endpoint with a fabricated file path', () => {
    const analysis: ModuleAnalysis = {
      functions: [fn('app.main.main', 'app/main.py')],
      edges: [edge('app.main.main', 'app.engine.Engine.__init__', 'internal_constructor')],
    };
    const { graph, stats } = buildGraph(analysis, options());
    const node = graph.nodes['app.engine.Engine.__init__'];
    expect(node).toBeDefined();
    expect(node).toMatchObject({
      kind: 'internal',
      synthetic: true,
      lineStart: 0,
      lineEnd: 0,
      name: '__init__',
      qualname: 'Engine.__init__',
      className: 'Engine',
      isMethod: true,
      file: 'app/engine.py',
      nCallers: 1,
      nCallees: 0,
    });
    expect(stats.internalNodes).toBe(2);
  });

  it('derives :: separated paths with the language extension', () => {
    const analysis: ModuleAnalysis = {
      functions: [fn('crate::app::run', 'app.rs', { name: 'run', qualname: 'run' })],
      edges: [edge('crate::app::run', 'crate::engine::Engine::new', 'internal_constructor')],
    };
    const { graph } = buildGraph(
      analysis,
      options({ defaultExt: '.rs', language: 'rust', scannedFiles: ['app.rs'] }),
    );
    const node = graph.nodes['crate::engine::Engine::new'];
    expect(node).toMatchObject({
      synthetic: true,
      file: 'crate/engine.rs',
      className: 'Engine',
      name: 'new',
    });
  });

  it('leaves the fabricated path extension-less when no defaultExt is given', () => {
    const analysis: ModuleAnalysis = {
      functions: [fn('app.main.main', 'app/main.py')],
      edges: [edge('app.main.main', 'app.engine.Engine.__init__', 'internal_constructor')],
    };
    const { graph } = buildGraph(analysis, options({ defaultExt: undefined }));
    expect(graph.nodes['app.engine.Engine.__init__']).toMatchObject({ file: 'app/engine' });
  });

  it('defensively synthesizes a non-constructor internal endpoint the adapter forgot to define', () => {
    const analysis: ModuleAnalysis = {
      functions: [fn('app.main.main', 'app/main.py')],
      edges: [edge('app.main.main', 'app.ghost.missing', 'internal_func')],
    };
    const { graph } = buildGraph(analysis, options());
    const node = graph.nodes['app.ghost.missing'];
    expect(node).toBeDefined();
    expect(node).toMatchObject({ kind: 'internal', synthetic: true, lineStart: 0, nCallers: 1 });
    expect(node?.kind === 'internal' && node.signature).toContain('synthesized');
  });
});

describe('buildGraph — boundary node synthesis', () => {
  it('splits class-looking segments into module/class/name', () => {
    const analysis: ModuleAnalysis = {
      functions: [fn('app.main.main', 'app/main.py')],
      edges: [edge('app.main.main', 'boundary:requests.Session.get', 'boundary')],
    };
    const { graph, stats } = buildGraph(analysis, options());
    expect(graph.nodes['boundary:requests.Session.get']).toMatchObject({
      kind: 'boundary',
      name: 'get',
      qualname: 'requests.Session.get',
      module: 'requests',
      className: 'Session',
      nCallers: 1,
    });
    expect(graph.metadata.nBoundaryNodes).toBe(1);
    expect(stats.boundaryNodes).toBe(1);
  });

  it('handles bare names, trailing class segments, and :: separators', () => {
    expect(synthesizeBoundary('boundary:sleep')).toMatchObject({ name: 'sleep', module: '', className: '' });
    // A trailing uppercase segment is the callee (a constructor), not a class prefix.
    expect(synthesizeBoundary('boundary:pkg.Mod')).toMatchObject({
      name: 'Mod',
      module: 'pkg',
      className: '',
    });
    expect(synthesizeBoundary('boundary:tokio::task::spawn')).toMatchObject({
      name: 'spawn',
      module: 'tokio.task',
      className: '',
    });
  });
});

describe('buildGraph — dropped-call classification', () => {
  const analysis: ModuleAnalysis = {
    functions: [fn('app.main.main', 'app/main.py')],
    edges: [
      edge('app.main.main', 'unresolved:self._logger.info', 'unresolved'),
      edge('app.main.main', 'unresolved:self.cache.get', 'unresolved'),
      edge('app.main.main', 'unresolved:len', 'unresolved'),
      edge('app.main.main', 'unresolved:conn.execute', 'unresolved'),
      edge('app.main.main', 'unresolved:do_stuff', 'unresolved'),
      edge('app.main.main', 'unresolved:"x".join', 'unresolved'),
    ],
  };
  const { graph, dropped, stats } = buildGraph(analysis, options());

  it('keeps unresolved edges out of the graph', () => {
    expect(graph.edges).toEqual([]);
    expect(graph.metadata.nEdges).toBe(0);
    expect(stats.edgesDropped).toBe(6);
    expect(graph.nodes['unresolved:len']).toBeUndefined();
  });

  it('buckets dropped edges by category with the unresolved: prefix stripped', () => {
    expect(dropped.metadata.totalDropped).toBe(6);
    expect(dropped.metadata.byCategory).toEqual({
      inherited_method: 1,
      self_attr_unknown: 1,
      builtin: 1,
      local_var_method: 1,
      bare_name: 1,
      string_literal_method: 1,
    });
    expect(dropped.edgesByCategory['inherited_method']?.[0]).toMatchObject({
      caller: 'app.main.main',
      calleeRaw: 'self._logger.info',
      line: 3,
    });
  });

  it('categorizeDropped covers the individual heuristics', () => {
    expect(categorizeDropped('unresolved:self.logger.debug')).toBe('inherited_method');
    expect(categorizeDropped('unresolved:this.emitter.emit')).toBe('self_attr_unknown');
    expect(categorizeDropped('unresolved:print(x)')).toBe('builtin');
    expect(categorizeDropped('unresolved:ValueError')).toBe('builtin');
    expect(categorizeDropped("unresolved:'fmt'.format")).toBe('string_literal_method');
    expect(categorizeDropped('unresolved:handler.dispatch')).toBe('local_var_method');
    expect(categorizeDropped('unresolved:frobnicate')).toBe('bare_name');
  });
});

describe('buildGraph — scan coverage', () => {
  const analysis: ModuleAnalysis = {
    functions: [fn('app.main.main', 'app/main.py')],
    edges: [],
    unparsedFiles: [
      { file: 'app/zeta.py', reason: 'partial', detail: 'the parse tree contains syntax errors' },
      { file: 'app/locked.py', reason: 'unreadable', detail: 'EACCES: permission denied' },
    ],
  };

  it('carries the record into graph.metadata so a graph.json reader sees the gap', () => {
    const { graph } = buildGraph(analysis, options({ unparsedFiles: analysis.unparsedFiles }));
    expect(graph.metadata.unparsedFiles).toEqual(analysis.unparsedFiles);
  });

  it('counts by reason and sorts by path, so an unchanged tree re-runs byte-identically', () => {
    const { scanCoverage, stats } = buildGraph(analysis, options({ unparsedFiles: analysis.unparsedFiles }));
    expect(scanCoverage.metadata.nUnparsed).toBe(2);
    expect(scanCoverage.metadata.nScanned).toBe(2); // the default options' scannedFiles
    expect(scanCoverage.metadata.byReason).toEqual({ partial: 1, unreadable: 1 });
    expect(scanCoverage.files.map((f) => f.file)).toEqual(['app/locked.py', 'app/zeta.py']);
    expect(stats.filesUnparsed).toBe(2);
  });

  it('states "nothing failed" rather than staying silent when the caller passes an empty list', () => {
    // Absent means "this analysis predates the record"; `[]` is a positive claim.
    const { graph, scanCoverage } = buildGraph(analysis, options({ unparsedFiles: [] }));
    expect(graph.metadata.unparsedFiles).toEqual([]);
    expect(scanCoverage.metadata.nUnparsed).toBe(0);
    expect(scanCoverage.metadata.byReason).toEqual({});
  });

  it('omits the field for a caller that says nothing at all', () => {
    const { graph } = buildGraph(analysis, options());
    expect(graph.metadata.unparsedFiles).toBeUndefined();
  });

  it('writes scan-coverage.json beside dropped-calls.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-graph-artifacts-'));
    try {
      writeGraphArtifacts(buildGraph(analysis, options({ unparsedFiles: analysis.unparsedFiles })), dir);
      const coverage = scanCoverageSchema.parse(
        JSON.parse(readFileSync(join(dir, 'scan-coverage.json'), 'utf8')),
      );
      expect(coverage.files.map((f) => f.reason)).toEqual(['unreadable', 'partial']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildGraph — parsed type declarations', () => {
  const type = (name: string, file: string, lineStart: number): TypeNode => ({
    id: `type:${file.replace(/\//g, '.').replace(/\.py$/, '')}.${name}`,
    name,
    qualname: name,
    file,
    lineStart,
    lineEnd: lineStart + 3,
    kind: 'class',
    signature: `class ${name}`,
    container: null,
  });

  it('leaves the graph without a `types` field when no adapter looked for any', () => {
    // Absent and empty are DIFFERENT statements: absent means nobody looked, and
    // writing `[]` instead would tell every consumer the codebase declares none.
    const result = buildGraph({ functions: [fn('app.main.main', 'app/main.py')], edges: [] }, options());
    expect(result.graph.types).toBeUndefined();
    expect(result.graph.metadata.nTypes).toBeUndefined();
    expect(result.stats.types).toBeUndefined();
  });

  it('keeps an EMPTY array when the adapter looked and found nothing', () => {
    const result = buildGraph(
      { functions: [fn('app.main.main', 'app/main.py')], edges: [], types: [] },
      options(),
    );
    expect(result.graph.types).toEqual([]);
    expect(result.graph.metadata.nTypes).toBe(0);
  });

  it('sorts by (file, lineStart, name) so an unchanged tree re-serializes identically', () => {
    // Adapters are driven one language at a time and `discoverAll`s iteration order
    // is nobody's promise, so a multi-language run could otherwise reorder the
    // array between two runs over the same source.
    const result = buildGraph(
      {
        functions: [],
        edges: [],
        types: [
          type('Zebra', 'app/engine.py', 40),
          type('Apple', 'app/engine.py', 40),
          type('Mid', 'app/engine.py', 10),
          type('First', 'app/aaa.py', 99),
        ],
      },
      options(),
    );
    expect((result.graph.types ?? []).map((t) => `${t.file}:${t.lineStart}:${t.name}`)).toEqual([
      'app/aaa.py:99:First',
      'app/engine.py:10:Mid',
      'app/engine.py:40:Apple',
      'app/engine.py:40:Zebra',
    ]);
  });

  it('counts types separately from functions, and never folds them in', () => {
    // `nInternalFunctions` is quoted as THE function count in every summary the
    // toolchain prints; a type added to it would silently inflate all of them.
    const result = buildGraph(
      {
        functions: [fn('app.main.main', 'app/main.py')],
        edges: [],
        types: [type('Engine', 'app/engine.py', 3), type('Wheel', 'app/engine.py', 20)],
      },
      options(),
    );
    expect(result.graph.metadata.nInternalFunctions).toBe(1);
    expect(result.graph.metadata.nTypes).toBe(2);
    expect(result.stats.types).toBe(2);
  });

  it('keeps types out of the call graph vertex set entirely', () => {
    // The design decision, asserted: `nodes` is what `edges` reference by id and
    // what thirteen consumers walk asking "is this a function?". A type in there
    // would be drawn in graphDots boundary cluster and counted as a function.
    const result = buildGraph(
      {
        functions: [fn('app.main.main', 'app/main.py')],
        edges: [],
        types: [type('Engine', 'app/engine.py', 3)],
      },
      options(),
    );
    expect(Object.keys(result.graph.nodes)).toEqual(['app.main.main']);
    expect(functionsCsv(result.graph)).not.toContain('Engine');
  });

  it('survives its own schema, so a written graph.json can be read back', () => {
    const result = buildGraph(
      {
        functions: [fn('app.main.main', 'app/main.py')],
        edges: [],
        types: [type('Engine', 'app/engine.py', 3)],
      },
      options(),
    );
    const parsed = codeGraphSchema.safeParse(JSON.parse(JSON.stringify(result.graph)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.types).toHaveLength(1);
  });

  it('refuses a type whose span was never parsed, rather than loading a fabricated range', () => {
    // `lineStart` is `.positive()` on purpose. A synthesized span is the one kind of
    // wrong an agent cannot detect — a stale path fails to open and a stale name
    // greps nothing, while a made-up line range opens the wrong code in silence.
    const bad = { ...type('Ghost', 'app/engine.py', 3), lineStart: 0 };
    const result = buildGraph({ functions: [], edges: [], types: [bad] }, options());
    const parsed = codeGraphSchema.safeParse(JSON.parse(JSON.stringify(result.graph)));
    expect(parsed.success).toBe(false);
  });
});

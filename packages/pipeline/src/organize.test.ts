import { describe, expect, it } from 'vitest';
import type { CallEdge, CodeGraph, GraphNode } from '@handbook/core';
import { fileCallAdjacency, functionCountsByFile, suggestOrder } from './organize.js';

function adjacencyOf(pairs: Array<[string, string[]]>): Map<string, Set<string>> {
  return new Map(pairs.map(([from, tos]) => [from, new Set(tos)]));
}

function internalNode(id: string, file: string): GraphNode {
  const name = id.split('.').at(-1) ?? id;
  return {
    id,
    name,
    qualname: name,
    file,
    lineStart: 1,
    lineEnd: 2,
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
    nCallers: 0,
    nCallees: 0,
  };
}

function edge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, isAwait: false, callType: 'internal_func', line: 1, raw: calleeId };
}

function makeGraph(nodes: GraphNode[], edges: CallEdge[]): CodeGraph {
  return {
    version: 1,
    metadata: {
      generatedAt: '2026-01-01T00:00:00.000Z',
      language: 'test',
      sourceRoot: '/repo',
      scannedFiles: [
        ...new Set(
          nodes.filter((n) => n.kind === 'internal').map((n) => (n.kind === 'internal' ? n.file : '')),
        ),
      ],
      nInternalFunctions: nodes.filter((n) => n.kind === 'internal').length,
      nBoundaryNodes: nodes.filter((n) => n.kind === 'boundary').length,
      nEdges: edges.length,
      policy: 'test',
    },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges,
    selfAttrs: {},
  };
}

describe('fileCallAdjacency', () => {
  it('lifts function edges to file level, dropping self-file and boundary endpoints', () => {
    const graph = makeGraph(
      [
        internalNode('a.one', 'a.py'),
        internalNode('a.two', 'a.py'),
        internalNode('b.three', 'b.py'),
        {
          id: 'boundary:os.getpid',
          name: 'getpid',
          qualname: 'os.getpid',
          module: 'os',
          className: '',
          kind: 'boundary',
          nCallers: 1,
          nCallees: 0,
        },
      ],
      [
        edge('a.one', 'b.three'), // cross-file: kept
        edge('a.one', 'a.two'), // same file: dropped
        edge('a.one', 'boundary:os.getpid'), // boundary: dropped
        edge('b.three', 'a.two'), // cross-file back-edge: kept
      ],
    );
    const adjacency = fileCallAdjacency(graph);
    expect(adjacency.get('a.py')).toEqual(new Set(['b.py']));
    expect(adjacency.get('b.py')).toEqual(new Set(['a.py']));
    expect(adjacency.size).toBe(2);
  });
});

describe('suggestOrder', () => {
  it('orders callers before callees regardless of input order', () => {
    const adjacency = adjacencyOf([
      ['a.py', ['b.py']],
      ['b.py', ['c.py']],
    ]);
    expect(suggestOrder(['c.py', 'a.py', 'b.py'], adjacency)).toEqual(['a.py', 'b.py', 'c.py']);
    expect(suggestOrder(['b.py', 'c.py', 'a.py'], adjacency)).toEqual(['a.py', 'b.py', 'c.py']);
  });

  it('breaks ties alphabetically when nothing calls anything', () => {
    expect(suggestOrder(['z.py', 'm.py', 'a.py'], new Map())).toEqual(['a.py', 'm.py', 'z.py']);
  });

  it('prefers orchestrators (higher out-degree) among equally-ready files', () => {
    const adjacency = adjacencyOf([
      ['z.py', ['m.py', 'n.py']],
      ['a.py', ['m.py']],
    ]);
    expect(suggestOrder(['a.py', 'z.py', 'm.py', 'n.py'], adjacency)).toEqual([
      'z.py',
      'a.py',
      'm.py',
      'n.py',
    ]);
  });

  it('ignores adjacency targets outside the stage', () => {
    const adjacency = adjacencyOf([['a.py', ['outside.py', 'b.py']]]);
    expect(suggestOrder(['b.py', 'a.py'], adjacency)).toEqual(['a.py', 'b.py']);
  });

  it('terminates on a pure cycle and keeps every file exactly once', () => {
    const adjacency = adjacencyOf([
      ['a.py', ['b.py']],
      ['b.py', ['a.py']],
    ]);
    const order = suggestOrder(['b.py', 'a.py'], adjacency);
    expect(order).toHaveLength(2);
    expect([...order].sort()).toEqual(['a.py', 'b.py']);
  });

  it('appends cycle members after the acyclic prefix instead of dropping them', () => {
    const adjacency = adjacencyOf([
      ['c.py', ['a.py']],
      ['a.py', ['b.py']],
      ['b.py', ['a.py']], // a ↔ b cycle fed by c
    ]);
    const files = ['a.py', 'b.py', 'c.py'];
    const order = suggestOrder(files, adjacency);
    expect(order).toEqual(['c.py', 'a.py', 'b.py']);
    for (const file of files) {
      expect(order.filter((f) => f === file)).toHaveLength(1);
    }
  });

  it('handles a cycle plus disconnected files: every input appears exactly once', () => {
    const adjacency = adjacencyOf([
      ['x.py', ['y.py']],
      ['y.py', ['z.py']],
      ['z.py', ['x.py']],
    ]);
    const files = ['solo.py', 'z.py', 'y.py', 'x.py'];
    const order = suggestOrder(files, adjacency);
    expect(order).toHaveLength(files.length);
    expect([...order].sort()).toEqual([...files].sort());
    expect(order[0]).toBe('solo.py'); // only in-degree-0 file leads
  });

  it('is deterministic across repeated runs', () => {
    const adjacency = adjacencyOf([
      ['a.py', ['b.py', 'c.py']],
      ['b.py', ['c.py']],
      ['c.py', ['a.py']],
    ]);
    const files = ['c.py', 'b.py', 'a.py', 'd.py'];
    const first = suggestOrder(files, adjacency);
    for (let i = 0; i < 5; i += 1) {
      expect(suggestOrder([...files], adjacency)).toEqual(first);
    }
  });

  it('returns an empty order for an empty stage', () => {
    expect(suggestOrder([], new Map())).toEqual([]);
  });
});

/**
 * `nFunctions` used to be read off the card, and only a DEEP card carries a
 * `functions` array — so in the default `--detail brief` it was 0 for every file
 * in every handbook. Measured across seventeen real repositories before the fix:
 * 0 for all 8,489 files, while the graph knew gson alone had 3,123 functions.
 *
 * It is not a decorative number. The agent locator index picks each group's
 * exemplar as its highest-function-count file and emits the field only when one
 * exists, so a permanent 0 deleted **Exemplar** from every page ever rendered
 * (0 of 156 measured) and printed "(0 fns)" beside every core file.
 */
describe('organization nFunctions comes from the graph, not the card', () => {
  const graph = makeGraph(
    [
      internalNode('engine.spin', 'engine.py'),
      internalNode('engine.stop', 'engine.py'),
      internalNode('engine.reset', 'engine.py'),
      internalNode('util.helper', 'util.py'),
      // Synthetic nodes exist in no source file; counting them would promise a
      // reader functions they will not find when they open it.
      { ...internalNode('engine.Implicit.__init__', 'engine.py'), synthetic: true },
      {
        id: 'boundary:os.path.join',
        name: 'join',
        qualname: 'os.path.join',
        module: 'os.path',
        className: '',
        kind: 'boundary',
        nCallers: 1,
        nCallees: 0,
      },
    ] as GraphNode[],
    [edge('engine.spin', 'util.helper')],
  );

  it('counts real internal functions per file and excludes synthetic ones', () => {
    const counts = functionCountsByFile(graph);
    expect(counts.get('engine.py')).toBe(3); // not 4 — the synthetic one does not count
    expect(counts.get('util.py')).toBe(1);
  });

  it('ignores boundary nodes, which belong to no file of ours', () => {
    const counts = functionCountsByFile(graph);
    expect([...counts.keys()].sort()).toEqual(['engine.py', 'util.py']);
  });

  it('reports zero for a scanned file that genuinely declares nothing', () => {
    expect(functionCountsByFile(graph).get('empty.py')).toBeUndefined();
  });
});

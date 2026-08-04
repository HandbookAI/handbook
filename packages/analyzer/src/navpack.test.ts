import { describe, expect, it } from 'vitest';
import type { CodeGraph } from '@handbook/core';
import { buildNavPack } from './navpack.js';

function graphWithBoundaryCalls(calleeIds: string[]): CodeGraph {
  const nodes: CodeGraph['nodes'] = {
    'app.main': {
      kind: 'internal',
      id: 'app.main',
      name: 'main',
      qualname: 'app.main',
      file: 'app.ts',
      lineStart: 1,
      lineEnd: 5,
      signature: 'main()',
      isAsync: false,
      isMethod: false,
      className: null,
      decorators: [],
      synthetic: false,
      selfAttrsRead: [],
      selfAttrsWritten: [],
      paramTypes: {},
      nCallees: calleeIds.length,
      nCallers: 0,
    },
  };
  for (const id of calleeIds) {
    const qualname = id.slice('boundary:'.length);
    nodes[id] = {
      kind: 'boundary',
      id,
      name: qualname.split('.').pop() ?? qualname,
      qualname,
      module: qualname,
      className: '',
      nCallees: 0,
      nCallers: 1,
    };
  }
  return {
    version: 1,
    metadata: {
      generatedAt: 'test',
      language: 'typescript',
      sourceRoot: '/tmp/x',
      scannedFiles: ['app.ts'],
      nInternalFunctions: 1,
      nBoundaryNodes: calleeIds.length,
      nEdges: calleeIds.length,
      policy: 'test',
    },
    nodes,
    edges: calleeIds.map((calleeId, i) => ({
      callerId: 'app.main',
      calleeId,
      isAwait: false,
      callType: 'boundary' as const,
      line: i + 1,
      raw: calleeId,
    })),
    selfAttrs: {},
  };
}

describe('buildNavPack — external subsystem keys', () => {
  it('keys relative-specifier boundaries by their module specifier, never an empty string', () => {
    const pack = buildNavPack(graphWithBoundaryCalls(['boundary:./helpers.js::shout']));
    const modules = pack.externalSubsystems.map((s) => s.module);
    expect(modules).toContain('./helpers.js');
    expect(modules).not.toContain('');
  });

  it('keeps node: scheme specifiers whole instead of collapsing them to "node"', () => {
    const pack = buildNavPack(
      graphWithBoundaryCalls(['boundary:node:fs.readFileSync', 'boundary:node:path.join']),
    );
    const modules = pack.externalSubsystems.map((s) => s.module);
    expect(modules).toContain('node:fs');
    expect(modules).toContain('node:path');
    expect(modules).not.toContain('node');
  });

  it('keys scoped packages by the full package name', () => {
    const pack = buildNavPack(graphWithBoundaryCalls(['boundary:@handbook/core::truncate']));
    expect(pack.externalSubsystems.map((s) => s.module)).toContain('@handbook/core');
  });

  it('keys plain qualified names by their first segment', () => {
    const pack = buildNavPack(graphWithBoundaryCalls(['boundary:Wheel.turn']));
    expect(pack.externalSubsystems.map((s) => s.module)).toContain('Wheel');
  });
});

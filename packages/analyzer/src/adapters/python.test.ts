import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
import { PythonAdapter } from './python.js';

const APP_PY = `
from engine import Engine
from helpers import shout

class App:
    def __init__(self, name: str, engine: Engine):
        self.name = name
        self.engine = engine
        self.parts = []

    async def run(self) -> str:
        self.prepare()
        out = await self.engine.spin()
        return shout(out)

    def prepare(self):
        self.parts.append(1)

    @staticmethod
    def version():
        return "1.0"

def main():
    app = App("x", Engine())
    print(app.run())
`;

const ENGINE_PY = `
import os

class Engine:
    def __init__(self):
        self.rpm = 0

    async def spin(self) -> int:
        self.rpm += 1
        os.getpid()
        return self.rpm
`;

const HELPERS_PY = `
def shout(text: str) -> str:
    def inner(t):
        return t.upper()
    return inner(text)
`;

describe('PythonAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-python-'));
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'app.py'), APP_PY);
    writeFileSync(join(root, 'pkg', 'engine.py'), ENGINE_PY.replace('from engine', '# noop'));
    writeFileSync(join(root, 'engine.py'), ENGINE_PY);
    writeFileSync(join(root, 'helpers.py'), HELPERS_PY);
    const adapter = new PythonAdapter();
    analysis = await adapter.analyze(['app.py', 'engine.py', 'helpers.py'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('extracts methods, functions, and nested defs', () => {
    expect(fn('app.App.run')).toBeDefined();
    expect(fn('app.App.run')?.isAsync).toBe(true);
    expect(fn('app.App.run')?.isMethod).toBe(true);
    expect(fn('app.main')?.isMethod).toBe(false);
    expect(fn('helpers.shout.inner')).toBeDefined();
  });

  it('marks staticmethods as non-methods and records decorators', () => {
    const version = fn('app.App.version');
    expect(version?.isMethod).toBe(false);
    expect(version?.decorators).toContain('staticmethod');
  });

  it('tracks self attribute reads and writes', () => {
    const init = fn('app.App.__init__');
    expect(init?.selfAttrsWritten).toEqual(expect.arrayContaining(['name', 'engine', 'parts']));
    const spin = fn('engine.Engine.spin');
    expect(spin?.selfAttrsWritten).toContain('rpm');
    expect(spin?.selfAttrsRead).toContain('rpm');
  });

  it('resolves self_method calls', () => {
    expect(edge('app.App.run', 'app.App.prepare')?.callType).toBe('self_method');
  });

  it('resolves self_attr_method through learned attribute types', () => {
    const e = edge('app.App.run', 'engine.Engine.spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.isAwait).toBe(true);
  });

  it('resolves imported functions and constructors cross-module', () => {
    expect(edge('app.App.run', 'helpers.shout')?.callType).toBe('internal_func');
    expect(edge('app.main', 'engine.Engine.__init__')?.callType).toBe('internal_constructor');
    expect(edge('app.main', 'app.App.__init__')?.callType).toBe('internal_constructor');
  });

  it('sends unknown calls to unresolved and externals to boundary', () => {
    const printEdge = analysis.edges.find((e) => e.callerId === 'app.main' && e.raw === 'print');
    expect(printEdge?.callType).toBe('unresolved');
    const osEdge = analysis.edges.find((e) => e.callerId === 'engine.Engine.spin' && e.raw === 'os.getpid');
    expect(osEdge?.callType).toBe('boundary');
    expect(osEdge?.calleeId).toBe('boundary:os.getpid');
  });

  it('records parameter types resolved through imports', () => {
    expect(fn('app.App.__init__')?.paramTypes.engine).toBe('engine.Engine');
  });
});

describe('PythonAdapter — module-alias calls (round-1 review)', () => {
  it('resolves alias.attr() into internal_func when the alias is our module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-python-alias-'));
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(join(root, 'pkg', '__init__.py'), '');
    writeFileSync(join(root, 'pkg', 'helpers.py'), 'def do():\n    return 1\n');
    writeFileSync(join(root, 'use.py'), 'from pkg import helpers\n\ndef go():\n    helpers.do()\n');
    const adapter = new PythonAdapter();
    const result = await adapter.analyze(['pkg/__init__.py', 'pkg/helpers.py', 'use.py'], root);
    const edge = result.edges.find((e) => e.callerId === 'use.go' && e.raw === 'helpers.do');
    expect(edge?.callType).toBe('internal_func');
    expect(edge?.calleeId).toBe('pkg.helpers.do');
  });
});

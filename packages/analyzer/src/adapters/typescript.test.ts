import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
import { TypeScriptAdapter } from './typescript.js';

const ENGINE_TS = `
export class Engine {
  rpm: number = 0;
  async spin(): Promise<number> {
    this.rpm += 1;
    return this.rpm;
  }
}
export function ignite(e: Engine): void {
  e.spin();
}
`;

const APP_TS = `
import { Engine } from './engine.js';
import * as fs from 'node:fs';
import { shout } from './helpers.js';
import * as h from './helpers.js';

export class App {
  private engine: Engine;
  label: string = '';
  greet = (msg: string): string => {
    return shout(msg);
  };

  constructor(private wheel: Wheel, engine: Engine) {
    this.engine = engine;
  }

  async run(): Promise<void> {
    this.prepare();
    await this.engine.spin();
    this.wheel.turn();
    fs.readFileSync('x');
    this.missing();
  }

  prepare(): void {
    this.label = 'ready';
  }
}

export function main(): void {
  const app = new App(null, new Engine());
  app.greet('hi');
  h.shout('ns');
  mystery();
}

const double = (x: number): number => { return x * 2; };
`;

const HELPERS_TS = `
export function shout(text: string): string {
  return text.toUpperCase();
}
`;

const WIDGET_TSX = `
import { shout } from './helpers.js';
export function Widget() {
  return <div>{shout('hey')}</div>;
}
`;

describe('TypeScriptAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new TypeScriptAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-ts-'));
    mkdirSync(join(root, 'ui'), { recursive: true });
    writeFileSync(join(root, 'app.ts'), APP_TS);
    writeFileSync(join(root, 'engine.ts'), ENGINE_TS);
    writeFileSync(join(root, 'helpers.ts'), HELPERS_TS);
    writeFileSync(join(root, 'ui', 'widget.tsx'), WIDGET_TSX);
    writeFileSync(join(root, 'types.d.ts'), 'export declare function ghost(): void;\n');
    analysis = await adapter.analyze(['app.ts', 'engine.ts', 'helpers.ts', 'ui/widget.tsx'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('discovers .ts/.tsx but never .d.ts', () => {
    const files = adapter.discover(root);
    expect(files).toContain('app.ts');
    expect(files).toContain('ui/widget.tsx');
    expect(files).not.toContain('types.d.ts');
  });

  it('extracts methods, arrow-function fields, and free functions', () => {
    expect(fn('app.App.run')?.isMethod).toBe(true);
    expect(fn('app.App.run')?.isAsync).toBe(true);
    expect(fn('app.App.greet')?.isMethod).toBe(true); // arrow field recorded as method
    expect(fn('app.main')?.isMethod).toBe(false);
    expect(fn('app.double')).toBeDefined(); // const arrow at top level
    expect(fn('ui.widget.Widget')).toBeDefined(); // tsx grammar
  });

  it('tracks this-attribute reads and writes', () => {
    expect(fn('app.App.constructor')?.selfAttrsWritten).toContain('engine');
    expect(fn('app.App.prepare')?.selfAttrsWritten).toContain('label');
    const spin = fn('engine.Engine.spin');
    expect(spin?.selfAttrsWritten).toContain('rpm');
    expect(spin?.selfAttrsRead).toContain('rpm');
  });

  it('resolves this.m() to self_method', () => {
    expect(edge('app.App.run', 'app.App.prepare')?.callType).toBe('self_method');
  });

  it('resolves this.field.m() through declared field types', () => {
    const e = edge('app.App.run', 'engine.Engine.spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.isAwait).toBe(true);
  });

  it('sends known-unscanned field types (constructor parameter properties) to boundary', () => {
    const e = edge('app.App.run', 'boundary:Wheel.turn');
    expect(e?.callType).toBe('boundary');
  });

  it('resolves param.m() through typed parameters', () => {
    expect(edge('engine.ignite', 'engine.Engine.spin')?.callType).toBe('param_method');
  });

  it('resolves new-expressions to constructors', () => {
    expect(edge('app.main', 'app.App.constructor')?.callType).toBe('internal_constructor');
    expect(edge('app.main', 'engine.Engine.constructor')?.callType).toBe('internal_constructor');
  });

  it('routes imports of unscanned modules to boundary', () => {
    expect(edge('app.App.run', 'boundary:node:fs.readFileSync')?.callType).toBe('boundary');
    // widget.tsx lives in ui/, so its './helpers.js' points at ui/helpers — not scanned.
    expect(edge('ui.widget.Widget', 'boundary:./helpers.js::shout')?.callType).toBe('boundary');
  });

  it('resolves named imports of scanned free functions to internal_func', () => {
    const e = edge('app.App.greet', 'helpers.shout');
    expect(e?.callType).toBe('internal_func');
  });

  it('resolves namespace-import calls into scanned modules to internal_func', () => {
    const e = edge('app.main', 'helpers.shout');
    expect(e?.callType).toBe('internal_func');
  });

  it('marks unknown calls unresolved', () => {
    const missing = analysis.edges.find((e) => e.callerId === 'app.App.run' && e.raw === 'this.missing');
    expect(missing?.callType).toBe('unresolved');
    const mystery = analysis.edges.find((e) => e.callerId === 'app.main' && e.raw === 'mystery');
    expect(mystery?.callType).toBe('unresolved');
    const local = analysis.edges.find((e) => e.callerId === 'app.main' && e.raw === 'app.greet');
    expect(local?.callType).toBe('unresolved');
  });

  it('records import-resolved parameter types', () => {
    expect(fn('engine.ignite')?.paramTypes.e).toBe('Engine');
  });
});

describe('TypeScriptAdapter — duplicate-id defenses (adversarial round)', () => {
  it('collapses a get/set pair (same id) to one node and does not multiply edges', async () => {
    const src = `
export class Box {
  #v = 0;
  get val(): number { peek(); return this.#v; }
  set val(n: number) { poke(); this.#v = n; }
}
function peek(): void {}
function poke(): void {}
`;
    const root = mkdtempSync(join(tmpdir(), 'hb-ts-getset-'));
    writeFileSync(join(root, 'a.ts'), src);
    const result = await new TypeScriptAdapter().analyze(['a.ts'], root);
    const ids = result.functions.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(result.functions.filter((f) => f.id === 'a.Box.val')).toHaveLength(1);
    // the shared-id node's edges are not duplicated across get+set bodies
    const valEdges = result.edges.filter((e) => e.callerId === 'a.Box.val');
    expect(valEdges.length).toBeLessThanOrEqual(2);
  });
});

/**
 * JavaScript rides on this adapter: the `typescript` grammar parses plain JS and
 * the `tsx` grammar parses JSX, both with zero parse errors, so `.js`/`.mjs`/
 * `.cjs`/`.jsx` are handled here rather than by a second adapter.
 */
const APP_JS = `
import { Engine } from './engine.SPEC_ENGINE';
import { shout } from './helpers.SPEC_HELPERS';

export class App {
  label = '';
  greet = (msg) => {
    return shout(msg);
  };

  constructor(engine) {
    this.engine = engine;
  }

  async run() {
    this.prepare();
    mystery();
  }

  prepare() {
    this.label = 'ready';
  }
}

export function main() {
  const app = new App(new Engine());
  app.greet('hi');
}

const double = (x) => { return x * 2; };
`;

const ENGINE_JS = `
export class Engine {
  async spin() {
    return 1;
  }
}
`;

const HELPERS_JS = `
export function shout(text) {
  return text.toUpperCase();
}
`;

const WIDGET_JSX = `
import { shout } from './helpers.SPEC_HELPERS';
export function Widget() {
  return <div>{shout('hey')}</div>;
}
`;

/** The fixture with import specifiers pointing at the given extensions. */
function withSpecifiers(source: string, engineExt: string, helpersExt: string): string {
  return source.replace('SPEC_ENGINE', engineExt).replace('SPEC_HELPERS', helpersExt);
}

describe('TypeScriptAdapter — JavaScript (.js/.mjs/.cjs/.jsx)', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new TypeScriptAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-js-'));
    writeFileSync(join(root, 'app.js'), withSpecifiers(APP_JS, 'mjs', 'cjs'));
    writeFileSync(join(root, 'engine.mjs'), ENGINE_JS);
    writeFileSync(join(root, 'helpers.cjs'), HELPERS_JS);
    writeFileSync(join(root, 'widget.jsx'), withSpecifiers(WIDGET_JSX, 'mjs', 'cjs'));
    writeFileSync(join(root, 'bundle.min.js'), 'function a(){b()}function b(){}\n');
    analysis = await adapter.analyze(['app.js', 'engine.mjs', 'helpers.cjs', 'widget.jsx'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('discovers every JS flavour but never a minified bundle or a .d.ts', () => {
    const files = adapter.discover(root);
    expect(files).toContain('app.js');
    expect(files).toContain('engine.mjs');
    expect(files).toContain('helpers.cjs');
    expect(files).toContain('widget.jsx');
    expect(files).not.toContain('bundle.min.js');
  });

  it('extracts class methods, arrow-function fields and top-level arrows', () => {
    expect(fn('app.App.run')?.isMethod).toBe(true);
    expect(fn('app.App.run')?.isAsync).toBe(true);
    expect(fn('app.App.greet')?.isMethod).toBe(true); // arrow field recorded as method
    expect(fn('app.main')?.isMethod).toBe(false);
    expect(fn('app.double')).toBeDefined();
    expect(fn('widget.Widget')).toBeDefined(); // tsx grammar on .jsx
  });

  it('tracks this-attribute writes without type annotations', () => {
    expect(fn('app.App.constructor')?.selfAttrsWritten).toContain('engine');
    expect(fn('app.App.prepare')?.selfAttrsWritten).toContain('label');
  });

  it('resolves this.m(), imports of scanned modules, and new-expressions', () => {
    expect(edge('app.App.run', 'app.App.prepare')?.callType).toBe('self_method');
    expect(edge('app.App.greet', 'helpers.shout')?.callType).toBe('internal_func');
    expect(edge('app.main', 'app.App.constructor')?.callType).toBe('internal_constructor');
    expect(edge('app.main', 'engine.Engine.constructor')?.callType).toBe('internal_constructor');
    expect(edge('widget.Widget', 'helpers.shout')?.callType).toBe('internal_func');
  });

  it('produces the same graph as the equivalent TypeScript source', async () => {
    // Module ids drop the extension, so an identical program in .ts must yield
    // identical nodes and edges — that is what "JavaScript is free" means.
    const tsRoot = mkdtempSync(join(tmpdir(), 'hb-js-ts-'));
    writeFileSync(join(tsRoot, 'app.ts'), withSpecifiers(APP_JS, 'js', 'js'));
    writeFileSync(join(tsRoot, 'engine.ts'), ENGINE_JS);
    writeFileSync(join(tsRoot, 'helpers.ts'), HELPERS_JS);
    writeFileSync(join(tsRoot, 'widget.tsx'), withSpecifiers(WIDGET_JSX, 'js', 'js'));
    const tsAnalysis = await adapter.analyze(
      ['app.ts', 'engine.ts', 'helpers.ts', 'widget.tsx'],
      tsRoot,
    );

    const shape = (a: ModuleAnalysis) => ({
      functions: a.functions.map((f) => [f.id, f.isMethod, f.isAsync, f.className] as const),
      edges: a.edges.map((e) => [e.callerId, e.calleeId, e.callType, e.isAwait] as const),
    });
    expect(shape(analysis)).toEqual(shape(tsAnalysis));
  });
});

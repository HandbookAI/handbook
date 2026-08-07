import { describe, expect, it } from 'vitest';
import type { FunctionNode } from '@handbook/core';
import {
  boundaryOf,
  buildStandardIndexes,
  dirOf,
  lookupScoped,
  resolveFieldType,
  resolveOwnMethod,
  resolveSameFileFree,
  resolveSiblingPackage,
  resolveViaImport,
  scopedKey,
  unresolvedOf,
  type BaseScan,
  type StandardIndexes,
} from './spine.js';

function scanOf(moduleId: string, over: Partial<BaseScan> = {}): BaseScan {
  return {
    moduleId,
    files: [`${moduleId.split('.').join('/')}.x`],
    functions: [],
    fnContext: new Map(),
    imports: new Map(),
    ownerMethods: new Map(),
    fieldTypes: new Map(),
    freeFunctions: new Set(),
    ...over,
  };
}

const emptyStd: StandardIndexes = buildStandardIndexes([]);

describe('buildStandardIndexes — moduleFunctions (audit finding A1)', () => {
  it('indexes every scan free function under its moduleId', () => {
    const std = buildStandardIndexes([
      scanOf('app', { freeFunctions: new Set(['main', 'boot']) }),
      scanOf('helpers', { freeFunctions: new Set(['shout']) }),
    ]);
    expect([...(std.moduleFunctions.get('app') ?? [])]).toEqual(['main', 'boot']);
    expect(std.moduleFunctions.get('helpers')?.has('shout')).toBe(true);
  });

  it('records an entry (empty) even for modules with no free functions', () => {
    const std = buildStandardIndexes([scanOf('types')]);
    expect(std.moduleFunctions.has('types')).toBe(true);
    expect(std.moduleFunctions.get('types')?.size).toBe(0);
  });

  it('unions scans that collapse to the same moduleId instead of dropping one', () => {
    const std = buildStandardIndexes([
      scanOf('pkg.mod', { files: ['pkg/mod.a'], freeFunctions: new Set(['one']) }),
      scanOf('pkg.mod', { files: ['pkg/mod.b'], freeFunctions: new Set(['two']) }),
    ]);
    expect([...(std.moduleFunctions.get('pkg.mod') ?? [])].sort()).toEqual(['one', 'two']);
  });

  it('misses names that were never declared free', () => {
    const std = buildStandardIndexes([scanOf('app', { freeFunctions: new Set(['main']) })]);
    expect(std.moduleFunctions.get('app')?.has('nope')).toBe(false);
  });
});

describe('buildStandardIndexes — typeToModule', () => {
  it('maps a declared owner to its scan module, first declaration winning', () => {
    const std = buildStandardIndexes([
      scanOf('a', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) }),
      scanOf('b', { ownerMethods: new Map([['Engine', new Set(['other'])]]) }),
    ]);
    expect(std.typeToModule.get('Engine')).toBe('a');
  });

  it('honours typeModules as the owning module (inline-module languages)', () => {
    const std = buildStandardIndexes([
      scanOf('lib', {
        ownerMethods: new Map([['S', new Set(['m'])]]),
        typeModules: new Map([['S', 'lib::outer']]),
      }),
    ]);
    expect(std.typeToModule.get('S')).toBe('lib::outer');
  });

  it('lets typeModules suppress owners the scan only implements but never declares', () => {
    // `impl Display for Foreign` must not claim `Foreign` as this module's type.
    const std = buildStandardIndexes([
      scanOf('mine', {
        ownerMethods: new Map([
          ['Mine', new Set(['m'])],
          ['Foreign', new Set(['fmt'])],
        ]),
        typeModules: new Map([['Mine', 'mine']]),
      }),
    ]);
    expect(std.typeToModule.get('Mine')).toBe('mine');
    expect(std.typeToModule.has('Foreign')).toBe(false);
  });
});

/**
 * The scope-aware table. `typeToModule` is keyed by bare name and keeps the
 * first `Config` it meets, which silently mis-picks in every language whose
 * type names are only unique within a package or namespace.
 */
describe('buildStandardIndexes — scopedTypeToModule', () => {
  const scopedScans = [
    scanOf('src.alpha.config', { scopedTypes: new Map([['alpha', new Set(['Config'])]]) }),
    scanOf('src.beta.config', { scopedTypes: new Map([['beta', new Set(['Config'])]]) }),
    scanOf('src.engine', { scopedTypes: new Map([['', new Set(['Engine'])]]) }),
  ];

  it('keys a type by its scope where the bare-name table cannot', () => {
    const std = buildStandardIndexes(scopedScans);
    expect(std.scopedTypeToModule.get(scopedKey('alpha', 'Config'))).toBe('src.alpha.config');
    expect(std.scopedTypeToModule.get(scopedKey('beta', 'Config'))).toBe('src.beta.config');
    // What it exists to avoid: one winner standing in for two real types.
    expect(std.typeToModule.get('Config')).toBeUndefined();
  });

  it('stays empty for a language that declares no scopes', () => {
    expect(buildStandardIndexes([scanOf('app')]).scopedTypeToModule.size).toBe(0);
  });

  it('keeps the first declaration of a name within one scope', () => {
    const std = buildStandardIndexes([
      scanOf('a', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
      scanOf('b', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
    ]);
    expect(std.scopedTypeToModule.get(scopedKey('ns', 'T'))).toBe('a');
  });

  it('honours typeModules as the owning module, like typeToModule does', () => {
    const std = buildStandardIndexes([
      scanOf('lib', {
        scopedTypes: new Map([['outer', new Set(['S'])]]),
        typeModules: new Map([['S', 'lib::outer']]),
      }),
    ]);
    expect(std.scopedTypeToModule.get(scopedKey('outer', 'S'))).toBe('lib::outer');
  });
});

describe('scopedKey / lookupScoped', () => {
  const table = buildStandardIndexes([
    scanOf('src.alpha.config', { scopedTypes: new Map([['alpha', new Set(['Config'])]]) }),
    scanOf('src.beta.config', { scopedTypes: new Map([['beta', new Set(['Config'])]]) }),
    scanOf('src.engine', { scopedTypes: new Map([['', new Set(['Engine'])]]) }),
  ]).scopedTypeToModule;

  it('cannot confuse scope and name across the separator', () => {
    expect(scopedKey('a::b', 'C')).not.toBe(scopedKey('a', 'b::C'));
  });

  it('returns the first hit in the caller resolution order, with its scope', () => {
    expect(lookupScoped(table, ['beta', 'alpha', ''], 'Config')).toEqual({
      scope: 'beta',
      value: 'src.beta.config',
    });
    expect(lookupScoped(table, ['alpha', 'beta', ''], 'Config')?.scope).toBe('alpha');
  });

  it('finds a global-scope type through the empty scope', () => {
    expect(lookupScoped(table, ['alpha', ''], 'Engine')).toEqual({
      scope: '',
      value: 'src.engine',
    });
  });

  it('misses when no scope in the order declares the name', () => {
    expect(lookupScoped(table, ['alpha', 'beta'], 'Engine')).toBeUndefined();
    expect(lookupScoped(table, [], 'Config')).toBeUndefined();
  });

  it('stops at the first hit rather than draining the scope order', () => {
    const tried: string[] = [];
    function* order(): Generator<string> {
      for (const scope of ['alpha', 'beta']) {
        tried.push(scope);
        yield scope;
      }
    }
    expect(lookupScoped(table, order(), 'Config')?.value).toBe('src.alpha.config');
    expect(tried).toEqual(['alpha']);
  });

  it('works on any scope-keyed table, not only the spine one', () => {
    const own = new Map([[scopedKey('demo', 'App::run'), 'src.app.App.run']]);
    expect(lookupScoped(own, ['', 'demo'], 'App::run')?.value).toBe('src.app.App.run');
  });
});

describe('buildStandardIndexes — typeMethods', () => {
  it('keys methods by owning module + owner and unions same-key scans', () => {
    const std = buildStandardIndexes([
      scanOf('m', { files: ['m.a'], ownerMethods: new Map([['T', new Set(['One'])]]) }),
      scanOf('m', { files: ['m.b'], ownerMethods: new Map([['T', new Set(['Two'])]]) }),
    ]);
    expect([...(std.typeMethods.get('m.T') ?? [])].sort()).toEqual(['One', 'Two']);
  });

  it('uses the language id separator', () => {
    const std = buildStandardIndexes(
      [scanOf('lib', { ownerMethods: new Map([['T', new Set(['m'])]]) })],
      '::',
    );
    expect(std.typeMethods.get('lib::T')?.has('m')).toBe(true);
    expect(std.typeMethods.has('lib.T')).toBe(false);
  });

  it('records declared-but-methodless owners as an empty set', () => {
    const std = buildStandardIndexes([scanOf('m', { ownerMethods: new Map([['T', new Set()]]) })]);
    expect(std.typeMethods.get('m.T')?.size).toBe(0);
  });
});

describe('buildStandardIndexes — directoryFunctions', () => {
  it('indexes free functions per directory, first file winning', () => {
    const std = buildStandardIndexes([
      scanOf('app.a', { files: ['app/a.x'], freeFunctions: new Set(['Helper']) }),
      scanOf('app.b', { files: ['app/b.x'], freeFunctions: new Set(['Helper', 'Other']) }),
    ]);
    const pkg = std.directoryFunctions.get('app');
    expect(pkg?.get('Helper')).toBe('app.a');
    expect(pkg?.get('Other')).toBe('app.b');
  });

  it('files at the root live under "."', () => {
    const std = buildStandardIndexes([
      scanOf('main', { files: ['main.x'], freeFunctions: new Set(['run']) }),
    ]);
    expect(std.directoryFunctions.get('.')?.get('run')).toBe('main');
  });

  it('indexes each file of a multi-file scan', () => {
    const std = buildStandardIndexes([
      scanOf('m', { files: ['one/m.x', 'two/m.x'], freeFunctions: new Set(['f']) }),
    ]);
    expect(std.directoryFunctions.get('one')?.get('f')).toBe('m');
    expect(std.directoryFunctions.get('two')?.get('f')).toBe('m');
  });
});

describe('buildStandardIndexes — moduleIds', () => {
  it('collects every scanned module id', () => {
    const std = buildStandardIndexes([scanOf('a'), scanOf('b'), scanOf('a')]);
    expect([...std.moduleIds].sort()).toEqual(['a', 'b']);
  });
});

describe('dirOf', () => {
  it('returns the parent directory, or "." at the root', () => {
    expect(dirOf('a/b/c.ts')).toBe('a/b');
    expect(dirOf('c.ts')).toBe('.');
  });
});

describe('resolveSameFileFree', () => {
  it('hits a free function declared in the same scan', () => {
    const scan = scanOf('app', { freeFunctions: new Set(['main']) });
    expect(resolveSameFileFree('main', scan)).toEqual({ calleeId: 'app.main', callType: 'internal_func' });
  });

  it('misses an unknown name', () => {
    expect(resolveSameFileFree('nope', scanOf('app'))).toBeUndefined();
  });

  it('uses the id separator', () => {
    const scan = scanOf('lib', { freeFunctions: new Set(['f']) });
    expect(resolveSameFileFree('f', scan, { separator: '::' })?.calleeId).toBe('lib::f');
  });

  it('prefers an explicit id when the default derivation would be wrong', () => {
    // Rust inline mods: the node id carries a `mod` prefix the moduleId lacks.
    const scan = scanOf('lib', { freeFunctions: new Set(['helper']) });
    const ids = new Map([['helper', 'lib::outer::inner::helper']]);
    expect(resolveSameFileFree('helper', scan, { idOf: (n) => ids.get(n) })?.calleeId).toBe(
      'lib::outer::inner::helper',
    );
  });

  it('misses when the explicit id lookup is ambiguous (no id)', () => {
    const scan = scanOf('lib', { freeFunctions: new Set(['helper']) });
    expect(resolveSameFileFree('helper', scan, { idOf: () => undefined })).toBeUndefined();
  });
});

describe('resolveSiblingPackage', () => {
  const std = buildStandardIndexes([
    scanOf('app.a', { files: ['app/a.x'] }),
    scanOf('app.b', { files: ['app/b.x'], freeFunctions: new Set(['Helper']) }),
  ]);

  it('hits a free function defined in a sibling file of the same directory', () => {
    const caller = scanOf('app.a', { files: ['app/a.x'] });
    expect(resolveSiblingPackage('Helper', caller, std)).toEqual({
      calleeId: 'app.b.Helper',
      callType: 'internal_func',
    });
  });

  it('misses a name no sibling defines', () => {
    expect(resolveSiblingPackage('Ghost', scanOf('app.a', { files: ['app/a.x'] }), std)).toBeUndefined();
  });

  it('misses across directories (a package is one directory)', () => {
    expect(resolveSiblingPackage('Helper', scanOf('other.c', { files: ['other/c.x'] }), std)).toBeUndefined();
  });
});

describe('resolveViaImport', () => {
  it('returns undefined when the local name is not imported', () => {
    expect(resolveViaImport('x', scanOf('a'), emptyStd)).toBeUndefined();
  });

  it('python shape: capitalized leaf resolves to a scanned class constructor', () => {
    const scan = scanOf('app', { imports: new Map([['Engine', 'engine.Engine']]) });
    const std = buildStandardIndexes([
      scanOf('engine', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) }),
    ]);
    expect(
      resolveViaImport('Engine', scan, std, {
        typeFirst: true,
        capitalizedTypesOnly: true,
        capitalizedIsConstructor: true,
        constructorName: '__init__',
      }),
    ).toEqual({ calleeId: 'engine.Engine.__init__', callType: 'internal_constructor' });
  });

  it('python shape: capitalized leaf of an unscanned module is a boundary constructor', () => {
    const scan = scanOf('app', { imports: new Map([['Thing', 'vendor.Thing']]) });
    expect(
      resolveViaImport('Thing', scan, emptyStd, {
        typeFirst: true,
        capitalizedTypesOnly: true,
        capitalizedIsConstructor: true,
        constructorName: '__init__',
      }),
    ).toEqual({ calleeId: 'boundary:vendor.Thing', callType: 'boundary_constructor' });
  });

  it('python shape: a lowercase leaf never takes the type branch', () => {
    // `class shouty` exists, but `from helpers import shouty` is a function call
    // site by Python convention — the old adapters gated on capitalization.
    const scan = scanOf('app', { imports: new Map([['shouty', 'helpers.shouty']]) });
    const std = buildStandardIndexes([
      scanOf('helpers', { ownerMethods: new Map([['shouty', new Set(['m'])]]) }),
    ]);
    expect(
      resolveViaImport('shouty', scan, std, {
        typeFirst: true,
        capitalizedTypesOnly: true,
        capitalizedIsConstructor: true,
        constructorName: '__init__',
        moduleOf: (source) => (std.moduleIds.has(source) ? source : undefined),
      }),
    ).toEqual({ calleeId: 'boundary:helpers.shouty', callType: 'boundary' });
  });

  it('python shape: a free function of a scanned module is internal_func', () => {
    const scan = scanOf('app', { imports: new Map([['shout', 'helpers.shout']]) });
    const std = buildStandardIndexes([scanOf('helpers', { freeFunctions: new Set(['shout']) })]);
    expect(
      resolveViaImport('shout', scan, std, {
        typeFirst: true,
        capitalizedTypesOnly: true,
        moduleOf: (source) => (std.moduleIds.has(source) ? source : undefined),
      }),
    ).toEqual({ calleeId: 'helpers.shout', callType: 'internal_func' });
  });

  it('typescript shape: the free-function branch wins over the type branch', () => {
    const scan = scanOf('app', { imports: new Map([['Engine', './engine.js::Engine']]) });
    const std = buildStandardIndexes([
      scanOf('engine', {
        freeFunctions: new Set(['Engine']),
        ownerMethods: new Map([['Engine', new Set(['spin'])]]),
      }),
    ]);
    const parse = (imported: string): { source: string; leaf: string } => {
      const at = imported.indexOf('::');
      return {
        source: at >= 0 ? imported.slice(0, at) : imported,
        leaf: imported.split('::').pop() ?? imported,
      };
    };
    expect(
      resolveViaImport('Engine', scan, std, {
        parse,
        constructorName: 'constructor',
        capitalizedIsConstructor: true,
        moduleOf: () => 'engine',
      }),
    ).toEqual({ calleeId: 'engine.Engine', callType: 'internal_func' });
  });

  it('rust shape: an ambiguous free-function lookup falls back to boundary', () => {
    const scan = scanOf('app', { imports: new Map([['shout', 'crate::helpers::shout']]) });
    expect(
      resolveViaImport('shout', scan, emptyStd, {
        separator: '::',
        typeFirst: true,
        constructorName: 'new',
        parse: (imported) => {
          const segments = imported.split('::');
          return { source: segments.slice(0, -1).join('::'), leaf: segments.at(-1) ?? imported };
        },
        // two candidates ⇒ the language declines to guess
        freeFunctionId: () => undefined,
      }),
    ).toEqual({ calleeId: 'boundary:crate::helpers::shout', callType: 'boundary' });
  });

  it('rust shape: a unique free-function id wins', () => {
    const scan = scanOf('app', { imports: new Map([['shout', 'crate::helpers::shout']]) });
    expect(
      resolveViaImport('shout', scan, emptyStd, {
        separator: '::',
        typeFirst: true,
        constructorName: 'new',
        parse: (imported) => {
          const segments = imported.split('::');
          return { source: segments.slice(0, -1).join('::'), leaf: segments.at(-1) ?? imported };
        },
        freeFunctionId: (source, leaf) => `src::${source.split('::').pop()}::${leaf}`,
      }),
    ).toEqual({ calleeId: 'src::helpers::shout', callType: 'internal_func' });
  });
});

describe('resolveOwnMethod', () => {
  const scan = scanOf('app', { ownerMethods: new Map([['App', new Set(['prepare'])]]) });

  it('hits a method declared on the owner in the same scan', () => {
    expect(resolveOwnMethod('App', 'prepare', scan, emptyStd)).toEqual({
      calleeId: 'app.App.prepare',
      callType: 'self_method',
    });
  });

  it('misses a method the owner does not declare', () => {
    expect(resolveOwnMethod('App', 'missing', scan, emptyStd)).toBeUndefined();
  });

  it('uses an explicit id base (inline-module owners)', () => {
    expect(
      resolveOwnMethod('App', 'prepare', scan, emptyStd, { separator: '::', idBase: 'lib::outer::App' })
        ?.calleeId,
    ).toBe('lib::outer::App::prepare');
  });

  it('finds a method declared in a sibling file only when crossModule is allowed', () => {
    // Go shape: `pkg/a` declares T and defines T.M; `pkg/b` defines T.Other and
    // calls `t.M()` on the same receiver type.
    const declaring = scanOf('pkg.a', {
      files: ['pkg/a.x'],
      typeModules: new Map([['T', 'pkg.a']]),
      ownerMethods: new Map([['T', new Set(['M'])]]),
    });
    const caller = scanOf('pkg.b', {
      files: ['pkg/b.x'],
      typeModules: new Map(),
      ownerMethods: new Map([['T', new Set(['Other'])]]),
    });
    const std = buildStandardIndexes([declaring, caller]);
    expect(resolveOwnMethod('T', 'M', caller, std)).toBeUndefined();
    expect(resolveOwnMethod('T', 'M', caller, std, { crossModule: true })).toEqual({
      calleeId: 'pkg.a.T.M',
      callType: 'self_method',
    });
  });
});

describe('resolveFieldType', () => {
  const scan = scanOf('app', {
    fieldTypes: new Map([
      ['App.engine', 'Engine'],
      ['App.wheel', 'Wheel'],
    ]),
  });
  const std = buildStandardIndexes([
    scanOf('engine', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) }),
  ]);

  it('hits a scanned type through a learned field type', () => {
    expect(resolveFieldType('App', 'engine', 'spin', scan, std)).toEqual({
      calleeId: 'engine.Engine.spin',
      callType: 'self_attr_method',
    });
  });

  it('sends a known-but-unscanned field type to boundary', () => {
    expect(resolveFieldType('App', 'wheel', 'turn', scan, std)).toEqual({
      calleeId: 'boundary:Wheel.turn',
      callType: 'boundary',
    });
  });

  it('misses when the field type was never learned', () => {
    expect(resolveFieldType('App', 'mystery', 'go', scan, std)).toBeUndefined();
  });

  it('uses the id separator on both hit and boundary paths', () => {
    const rust = scanOf('src::app', {
      fieldTypes: new Map([
        ['App.engine', 'Engine'],
        ['App.x', 'Ghost'],
      ]),
    });
    const rustStd = buildStandardIndexes(
      [scanOf('src::engine', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) })],
      '::',
    );
    expect(resolveFieldType('App', 'engine', 'spin', rust, rustStd, { separator: '::' })?.calleeId).toBe(
      'src::engine::Engine::spin',
    );
    expect(resolveFieldType('App', 'x', 'go', rust, rustStd, { separator: '::' })?.calleeId).toBe(
      'boundary:Ghost::go',
    );
  });
});

describe('boundaryOf / unresolvedOf', () => {
  it('builds boundary ids with and without a member', () => {
    expect(boundaryOf('node:fs', 'readFileSync')).toEqual({
      calleeId: 'boundary:node:fs.readFileSync',
      callType: 'boundary',
    });
    expect(boundaryOf('println!')).toEqual({ calleeId: 'boundary:println!', callType: 'boundary' });
    expect(boundaryOf('std::collections::HashMap', 'new', { separator: '::', isConstructor: true })).toEqual({
      calleeId: 'boundary:std::collections::HashMap::new',
      callType: 'boundary_constructor',
    });
  });

  it('truncates unresolved hints so a huge callee text cannot bloat the graph', () => {
    const hint = 'x'.repeat(200);
    const resolved = unresolvedOf(hint);
    expect(resolved.callType).toBe('unresolved');
    expect(resolved.calleeId.length).toBe('unresolved:'.length + 80);
    expect(unresolvedOf('self.missing').calleeId).toBe('unresolved:self.missing');
  });
});

describe('BaseScan function nodes', () => {
  it('carries the language-agnostic FunctionNode shape', () => {
    const node: FunctionNode = {
      id: 'app.main',
      name: 'main',
      qualname: 'main',
      file: 'app.x',
      lineStart: 1,
      lineEnd: 2,
      signature: 'main()',
      isAsync: false,
      isMethod: false,
      className: null,
      decorators: [],
      kind: 'internal',
      synthetic: false,
      selfAttrsRead: [],
      selfAttrsWritten: [],
      paramTypes: {},
    };
    const scan = scanOf('app', { functions: [node] });
    expect(buildStandardIndexes([scan]).moduleIds.has('app')).toBe(true);
    expect(scan.functions[0]?.id).toBe('app.main');
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Node } from 'web-tree-sitter';
import type { FunctionNode, Logger, TypeKind, TypeNode } from '@handbook/core';
import {
  createAdapter,
  boundaryOf,
  buildStandardIndexes,
  declaredTypeKinds,
  dedupeTypesById,
  dirKey,
  dirOf,
  lookupBareType,
  lookupScoped,
  recordType,
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
  it('maps a declared owner to its scan module', () => {
    const std = buildStandardIndexes([
      scanOf('a', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) }),
    ]);
    expect(std.typeToModule.get('Engine')).toBe('a');
    expect(std.ambiguousTypes.has('Engine')).toBe(false);
  });

  it('withdraws a bare name two modules both declare, instead of picking the first', () => {
    // This assertion used to require `'a'` — first declaration wins — and that
    // expectation was the bug. Two modules declaring `Config`, or `Engine`, is
    // routine above a few thousand lines, and the winner then answered for
    // every later reference: `from b import Engine; Engine()` resolved to A's
    // constructor and shipped as a REAL edge with dropped-calls.json empty.
    // A guessed edge is indistinguishable from a real one downstream, which is
    // precisely what invariant 2 forbids.
    const std = buildStandardIndexes([
      scanOf('a', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) }),
      scanOf('b', { ownerMethods: new Map([['Engine', new Set(['other'])]]) }),
    ]);
    expect(std.typeToModule.has('Engine')).toBe(false);
    expect(std.ambiguousTypes.has('Engine')).toBe(true);
  });

  it('does not call a name ambiguous when both scans agree on the module', () => {
    // Two scans of the same module (a re-scan, or a language whose scan is
    // emitted per file) must not withdraw the name from the table.
    const std = buildStandardIndexes([
      scanOf('same', { ownerMethods: new Map([['Engine', new Set(['spin'])]]) }),
      scanOf('same', { ownerMethods: new Map([['Engine', new Set(['other'])]]) }),
    ]);
    expect(std.typeToModule.get('Engine')).toBe('same');
    expect(std.ambiguousTypes.has('Engine')).toBe(false);
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

  it('withdraws a name two modules declare in the same scope', () => {
    // This test previously asserted that the FIRST declaration won, which was
    // the defect written down as an expectation. A scope is not unique across a
    // repository: C++ re-opens `namespace detail` in every file that wants it,
    // so `detail::Impl` in two translation units is two unrelated types. Giving
    // it to whichever file was scanned first resolved every reference to one of
    // them and shipped the result as a real edge — invariant 2's exact
    // prohibition, with `dropped-calls.json` left empty.
    const std = buildStandardIndexes([
      scanOf('a', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
      scanOf('b', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
    ]);
    expect(std.scopedTypeToModule.has(scopedKey('ns', 'T'))).toBe(false);
    expect(std.ambiguousScopedTypes.has(scopedKey('ns', 'T'))).toBe(true);
  });

  it('does not let a third declaration re-award a withdrawn name', () => {
    // Order must not decide it. Once withdrawn, a later scan claiming the same
    // key cannot put it back — otherwise the answer depends on scan order,
    // which is the property that made this wrong in the first place.
    const std = buildStandardIndexes([
      scanOf('a', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
      scanOf('b', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
      scanOf('c', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
    ]);
    expect(std.scopedTypeToModule.has(scopedKey('ns', 'T'))).toBe(false);
  });

  it('leaves an unambiguous scoped name alone', () => {
    const std = buildStandardIndexes([
      scanOf('a', { scopedTypes: new Map([['ns', new Set(['T'])]]) }),
      scanOf('b', { scopedTypes: new Map([['other', new Set(['T'])]]) }),
    ]);
    expect(std.scopedTypeToModule.get(scopedKey('ns', 'T'))).toBe('a');
    expect(std.ambiguousScopedTypes.size).toBe(0);
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

describe('an ambiguous scope ends the lookup instead of falling outward', () => {
  /**
   * The subtle half of the fix. Withdrawing `detail::Impl` from the table is
   * not enough on its own: `lookupScoped` walks scopes from innermost outward,
   * so a withdrawn inner key just means the walk continues and finds the GLOBAL
   * `Impl` — turning "we cannot tell which of these two" into a confident edge
   * pointing at a third thing entirely. That is worse than the original bug.
   */
  const std = buildStandardIndexes([
    scanOf('a', { scopedTypes: new Map([['detail', new Set(['Impl'])]]) }),
    scanOf('b', { scopedTypes: new Map([['detail', new Set(['Impl'])]]) }),
    scanOf('global', { scopedTypes: new Map([['', new Set(['Impl'])]]) }),
  ]);

  it("finds nothing, rather than the enclosing scope's unrelated type", () => {
    const hit = lookupScoped(std.scopedTypeToModule, ['detail', ''], 'Impl', std.ambiguousScopedTypes);
    expect(hit).toBeUndefined();
  });

  it('would have resolved to the outer scope without the ambiguity set', () => {
    // The same call WITHOUT the set — proving the guard is what stops it, and
    // that this test is not passing for some unrelated reason.
    const hit = lookupScoped(std.scopedTypeToModule, ['detail', ''], 'Impl');
    expect(hit?.value).toBe('global');
  });

  it('still resolves a name that is only ambiguous in some other scope', () => {
    const hit = lookupScoped(std.scopedTypeToModule, ['', 'detail'], 'Impl', std.ambiguousScopedTypes);
    expect(hit?.value).toBe('global');
  });
});

describe('lookupBareType', () => {
  it('answers undefined for a name nobody declares', () => {
    expect(lookupBareType(buildStandardIndexes([scanOf('a')]), 'Nope')).toBeUndefined();
  });

  it('answers undefined for a name two modules declare', () => {
    // Callers want the same thing in both cases — fall through to
    // `unresolvedOf` — and the whole point of the helper is that an adapter
    // cannot forget the second case.
    const std = buildStandardIndexes([
      scanOf('a', { ownerMethods: new Map([['Config', new Set(['load'])]]) }),
      scanOf('b', { ownerMethods: new Map([['Config', new Set(['save'])]]) }),
    ]);
    expect(lookupBareType(std, 'Config')).toBeUndefined();
  });

  it('answers the module for an unambiguous one', () => {
    const std = buildStandardIndexes([scanOf('a', { ownerMethods: new Map([['Only', new Set()]]) })]);
    expect(lookupBareType(std, 'Only')).toBe('a');
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
  it('withdraws a free function two files in one directory both declare', () => {
    // Also previously an assertion that first-wins was correct. Go cannot
    // produce this — one package, one name, or it does not compile — but Swift
    // shares this table and its `private func` is FILE-scoped, so two files
    // legitimately declaring `Helper` is ordinary Swift. Pointing one file's
    // call at the other file's function is an invented edge.
    const std = buildStandardIndexes([
      scanOf('app.a', { files: ['app/a.x'], freeFunctions: new Set(['Helper']) }),
      scanOf('app.b', { files: ['app/b.x'], freeFunctions: new Set(['Helper', 'Other']) }),
    ]);
    const pkg = std.directoryFunctions.get('app');
    expect(pkg?.has('Helper')).toBe(false);
    expect(std.ambiguousDirectoryFunctions.has(dirKey('app', 'Helper'))).toBe(true);
    // The name only ONE of them declares is unaffected.
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

describe('SpineAdapter.analyze — WASM lifetime', () => {
  /**
   * Regression for an analyze that died 90% of the way through a 4,937-file
   * polyglot repository with
   *
   *     RuntimeError: table index is out of bounds
   *         at tree-sitter.wasm.ts_parser_new_wasm
   *
   * The cause was every parsed tree staying alive for the whole process: trees
   * own memory in one WASM instance shared by every grammar, and the JS garbage
   * collector cannot reclaim it. Four languages' worth of held trees exhausted
   * the shared table, and the fifth language's first `new Parser()` was what
   * happened to be holding the gun.
   *
   * Reproducing the exhaustion itself needs thousands of real source files, so
   * this asserts the FIX rather than the symptom: after `analyze` resolves, the
   * trees it parsed have been freed. A freed tree's nodes stop reporting their
   * real type — the observable signal that the memory went back, and stable
   * because `web-tree-sitter` is pinned to `~0.25.10`.
   *
   * The ordering half matters just as much: the free must happen AFTER pass 2,
   * because `spec.scan` hands `extractCalls` live nodes. Freeing during pass 1
   * would swap a crash for silently wrong call facts, so the test also records
   * what the node looked like while `extractCalls` was running.
   */
  it('frees every parsed tree once it is done, and not before pass 2 has read it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spine-lifetime-'));
    try {
      writeFileSync(join(root, 'a.py'), 'def alpha():\n    return 1\n');
      writeFileSync(join(root, 'b.py'), 'def beta():\n    return alpha()\n');

      const captured: Node[] = [];
      let typeDuringExtract: string | undefined;

      const adapter = createAdapter<BaseScan>({
        name: 'lifetime-probe',
        extensions: ['.py'],
        grammarFor: () => 'python',
        moduleIdForFile: (file) => file.replace(/\.py$/, ''),
        capabilities: {
          tier: 'generic',
          callTypes: ['unresolved'],
          selfAttrs: false,
          statementSpans: false,
        },
        emptyScan: (moduleId) => ({
          moduleId,
          files: [],
          functions: [],
          fnContext: new Map(),
          imports: new Map(),
          ownerMethods: new Map(),
          fieldTypes: new Map(),
          freeFunctions: new Set(),
        }),
        scan: (_scan, node) => {
          captured.push(node);
        },
        extractCalls: () => {
          // Pass 2 runs while the trees are still alive — that is the contract
          // `fnContext`'s body nodes depend on.
          typeDuringExtract = captured[0]?.type;
          return [];
        },
      });

      await adapter.analyze(['a.py', 'b.py'], root);

      expect(captured).toHaveLength(2);
      expect(typeDuringExtract).toBe('module'); // alive when extractCalls ran
      // …and dead afterwards, for every tree, not just the last one.
      expect(captured.map((node) => node.type)).toEqual(['ERROR', 'ERROR']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SpineAdapter.analyze — files it could not turn into facts', () => {
  /**
   * The driver had two silent `continue`s — an unreadable file and a null tree —
   * and never asked `rootNode.hasError`. All three left the file listed as
   * scanned with zero functions, which the cards pass then described as "a file
   * with 0 functions" and `_coverage.json` counted as fully covered: the
   * handbook asserted, as a parser fact, something no parser ever saw.
   *
   * A real mini-repo with a real grammar, because the whole question here is
   * what tree-sitter does with broken source. `broken.py` is a DIRECTORY rather
   * than a chmod-000 file: `readFileSync` raises EISDIR for every user, whereas
   * a mode-000 file is readable by root and the test would pass vacuously in a
   * container.
   */
  const spec = (log: string[]) =>
    createAdapter<BaseScan>({
      name: 'coverage-probe',
      extensions: ['.py'],
      grammarFor: () => 'python',
      moduleIdForFile: (file) => file.replace(/\.py$/, ''),
      capabilities: { tier: 'generic', callTypes: ['unresolved'], selfAttrs: false, statementSpans: false },
      emptyScan: (moduleId) => ({
        moduleId,
        files: [],
        functions: [],
        fnContext: new Map(),
        imports: new Map(),
        ownerMethods: new Map(),
        fieldTypes: new Map(),
        freeFunctions: new Set(),
      }),
      scan: (scan, root, file) => {
        for (const child of root.namedChildren) {
          if (child?.type !== 'function_definition') continue;
          const name = child.childForFieldName('name')?.text ?? '?';
          scan.freeFunctions.add(name);
          scan.functions.push(fnNode(`${scan.moduleId}.${name}`, name, file));
        }
        log.push(`scanned ${file}`);
      },
      extractCalls: () => [],
    });

  function fnNode(id: string, name: string, file: string): FunctionNode {
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
    };
  }

  let root: string;
  let warnings: string[];
  let scanned: string[];
  let analysis: Awaited<ReturnType<ReturnType<typeof spec>['analyze']>>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'spine-scan-coverage-'));
    writeFileSync(join(root, 'good.py'), 'def alpha():\n    return 1\n');
    mkdirSync(join(root, 'broken.py'));
    // Above the 8 MiB scan ceiling. Real content, so nothing about this test
    // depends on the file being unparseable — it is skipped purely on size.
    writeFileSync(join(root, 'huge.py'), `def gamma():\n    return 3\n${'# pad\n'.repeat(2_200_000)}`);
    writeFileSync(join(root, 'partial.py'), 'def beta():\n    return 2\n\nclass Wrong(:\n    pass\n');
    warnings = [];
    scanned = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (m) => warnings.push(m),
      error: () => {},
      child: () => logger,
    };
    analysis = await spec(scanned).analyze(['good.py', 'broken.py', 'partial.py', 'huge.py'], root, {
      logger,
    });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('records the unreadable file with its real cause instead of dropping it', () => {
    const entry = analysis.unparsedFiles?.find((f) => f.file === 'broken.py');
    expect(entry?.reason).toBe('unreadable');
    expect(entry?.detail).toMatch(/EISDIR|illegal operation on a directory/i);
    expect(scanned).not.toContain('scanned broken.py');
  });

  it('warns about it, so a run that lost a file does not end like a clean one', () => {
    expect(warnings.some((w) => w.includes('broken.py') && /unreadable/.test(w))).toBe(true);
  });

  it('records a file tree-sitter parsed with syntax errors as partial', () => {
    const entry = analysis.unparsedFiles?.find((f) => f.file === 'partial.py');
    expect(entry?.reason).toBe('partial');
    expect(entry?.detail).toMatch(/incomplete/);
    expect(warnings.some((w) => w.includes('parsed with syntax errors'))).toBe(true);
  });

  it('keeps the facts a partial parse DID yield', () => {
    // The point of `partial` rather than `unparsable`: `beta` is real, the file
    // is still scanned, and only what sat inside the ERROR node is missing.
    expect(scanned).toContain('scanned partial.py');
    expect(analysis.functions.map((f) => f.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('says nothing about a file that read and parsed cleanly', () => {
    expect(analysis.unparsedFiles?.some((f) => f.file === 'good.py')).toBe(false);
  });

  describe('a file too large to be worth parsing', () => {
    /**
     * A minified bundle or a generated table can be hundreds of megabytes. Read
     * as UTF-8 it becomes a JS string about twice that in memory, and then
     * tree-sitter is asked to parse it — spending the memory and the minutes on
     * a card nobody will read. Skipping it is right; skipping it SILENTLY is the
     * same defect as the unreadable file above.
     */
    it('is skipped rather than read', () => {
      expect(scanned).not.toContain('scanned huge.py');
      expect(analysis.functions.map((f) => f.name)).not.toContain('gamma');
    });

    it('is recorded with the size as the reason, not a parser failure', () => {
      const entry = analysis.unparsedFiles?.find((f) => f.file === 'huge.py');
      expect(entry?.reason).toBe('unreadable');
      // The detail has to name the SIZE. "unreadable" alone would send the
      // reader looking at file permissions.
      expect(entry?.detail).toMatch(/MiB.*limit/);
    });

    it('warns, so the gap is visible in the run log too', () => {
      expect(warnings.some((w) => w.includes('huge.py') && /above the/.test(w))).toBe(true);
    });
  });
});

describe('declaredTypeKinds', () => {
  it('reports the distinct kinds a node-type map produces, sorted', () => {
    // Sorted because the result lands in graph.json: an unchanged analysis must
    // re-serialize byte-identically, and Map insertion order is not that promise.
    const kinds = new Map<string, TypeKind>([
      ['interface_declaration', 'interface'],
      ['class_declaration', 'class'],
      ['abstract_class_declaration', 'class'],
    ]);
    expect(declaredTypeKinds(kinds)).toEqual(['class', 'interface']);
  });

  it('is derived, so widening the map widens the declaration in the same edit', () => {
    // The whole point: a hand-written list is how a capability claim goes stale.
    const before = new Map<string, TypeKind>([['class_declaration', 'class']]);
    const after = new Map(before).set('record_declaration', 'record');
    expect(declaredTypeKinds(before)).toEqual(['class']);
    expect(declaredTypeKinds(after)).toEqual(['class', 'record']);
  });

  it('reports nothing for an empty map', () => {
    expect(declaredTypeKinds(new Map())).toEqual([]);
  });
});

describe('dedupeTypesById', () => {
  const type = (id: string, lineStart: number): TypeNode => ({
    id,
    name: 'Merged',
    qualname: 'Merged',
    file: 'm.ts',
    lineStart,
    lineEnd: lineStart + 2,
    kind: 'interface',
    signature: 'interface Merged',
    container: null,
  });

  it('keeps the FIRST declaration, unlike dedupeFunctionsById which keeps the last', () => {
    // For a function, last-wins is semantic: the last definition is the one live at
    // runtime. For a merged TypeScript interface BOTH halves are live, so the
    // earliest is where a reader starts — and it is the only choice that keeps the
    // span pointing at the first thing in the file.
    const kept = dedupeTypesById([type('type:m.Merged', 10), type('type:m.Merged', 40)]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.lineStart).toBe(10);
  });

  it('keeps distinct ids apart', () => {
    const kept = dedupeTypesById([type('type:m.A', 1), type('type:m.B', 5)]);
    expect(kept.map((t) => t.id)).toEqual(['type:m.A', 'type:m.B']);
  });
});

describe('a type signature always names the type it declares', () => {
  /**
   * The span starts where the grammar's declaration node starts, which for an
   * attributed declaration is the attribute. That is the honest span and it is
   * kept — but it meant a long attribute could push the name past the 200-char
   * cap, leaving a signature that does not say what it declares. Measured on
   * real repositories: 58/7212 rows in flutter/packages, 43/424 in Alamofire,
   * 25/414 in spdlog, and 4/1756 in Newtonsoft.Json, which predates types
   * entirely.
   *
   * A signature without the name is not a shorter signature; the column exists
   * to identify the declaration.
   */
  function signatureOf(source: string, name: string): string | undefined {
    const scan: BaseScan = {
      moduleId: 'm',
      files: ['a.x'],
      functions: [],
      fnContext: new Map(),
      imports: new Map(),
      ownerMethods: new Map(),
      fieldTypes: new Map(),
      freeFunctions: new Set(),
    };
    // A stand-in for a grammar node: `recordType` only reads text and positions.
    const bodyAt = source.indexOf('{');
    const node = {
      text: source,
      startIndex: 0,
      endIndex: source.length,
      startPosition: { row: 0 },
      endPosition: { row: source.split('\n').length - 1 },
    } as unknown as Node;
    const body = { startIndex: bodyAt } as unknown as Node;
    recordType(scan, { name, kind: 'class', node, body, file: 'a.x' });
    return scan.typeNodes?.[0]?.signature;
  }

  it('keeps a short attributed declaration verbatim', () => {
    expect(signatureOf('@immutable class Annotated {}', 'Annotated')).toBe('@immutable class Annotated');
  });

  it('elides the attributes when they would cut the name away', () => {
    const long = `@Attribute(${'x'.repeat(400)}) class Buried {}`;
    const sig = signatureOf(long, 'Buried') ?? '';
    expect(sig).toContain('Buried');
    // Marked, so nobody reads it as the declaration verbatim.
    expect(sig.startsWith('… ')).toBe(true);
    expect(sig.length).toBeLessThanOrEqual(202);
  });

  it('still caps a declaration whose name is early but whose header is long', () => {
    const long = `class Wide extends ${'A'.repeat(400)} {}`;
    const sig = signatureOf(long, 'Wide') ?? '';
    expect(sig).toContain('Wide');
    expect(sig.startsWith('…')).toBe(false);
    expect(sig.length).toBeLessThanOrEqual(200);
  });

  it('falls back to the plain cap when the header does not name the type at all', () => {
    // Nothing better to offer, and inventing a name would be worse than a
    // signature that happens to be unhelpful.
    //
    // Asserted on the PREFIX, not on the absence of an ellipsis: `truncate`
    // appends one of its own when it cuts a tail, so the two marks coexist and
    // mean different things — a LEADING `… ` says attributes were removed from
    // the front, a trailing one says the tail was cut. Testing for "no ellipsis
    // anywhere" conflated them, and the first version of this test failed for
    // that reason rather than for a defect.
    const sig = signatureOf(`${'z'.repeat(300)} {}`, 'Absent') ?? '';
    expect(sig.startsWith('… ')).toBe(false);
    expect(sig.length).toBeLessThanOrEqual(200);
  });
});

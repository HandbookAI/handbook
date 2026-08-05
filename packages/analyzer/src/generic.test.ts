/**
 * Generic-engine tests.
 *
 * Two layers. Per LANGUAGE: a fixture repo on disk, asserting that discovery,
 * function extraction, internal call resolution and the capability declaration
 * all hold for real source in that language — the node type lists are guesses
 * about a grammar until a fixture proves them. Per ENGINE: the failure modes
 * every configuration shares (a node type this grammar does not have, a file
 * that cannot be read, a file that does not parse, a spec that over-claims).
 *
 * The one invariant asserted for every language: no `self_attr_method` and no
 * `param_method` edge, ever. Those need type inference; a generic-tier handbook
 * that showed them would be claiming fidelity it does not have.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbook/core';
import { createGenericAdapter, GENERIC_CALL_TYPES, GENERIC_LANGUAGES } from './generic.js';
import type { LanguageAdapter } from './adapter.js';

interface LanguageFixture {
  /** relative path → source. */
  files: Record<string, string>;
  /** Every function id the engine must find, exactly. */
  functions: string[];
  /** A resolved call inside one file: caller id → callee id, plus its callType. */
  internalCall: [string, string, CallType];
  /**
   * A bare call resolved to a free function in a SIBLING file — the cross-module
   * index whose absence in two hand-written adapters was audit finding A1. Every
   * generic language gets it from the spine whether it asked for it or not.
   */
  siblingCall: [string, string];
  /** Function id → whether the engine read it as async (async markers). */
  async?: Record<string, boolean>;
}

const KOTLIN: LanguageFixture = {
  files: {
    'demo/app.kt': `package demo

import demo.engine.Engine
import kotlin.math.max

class App(private val engine: Engine) {
    fun run(): String {
        prepare()
        this.prepare()
        ignite()
        max(1, 2)
        mystery()
        return shout("x")
    }

    private fun prepare(): String {
        return "ready"
    }

    suspend fun later(): String {
        return prepare()
    }
}

fun shout(text: String): String = text

fun main() {
    val a = App(Engine())
    a.run()
}
`,
    'demo/engine.kt': `package demo.engine

class Engine {
    fun spin(): Int = 1
}

fun ignite(): Int = 0
`,
  },
  functions: [
    'demo.app.App.later',
    'demo.app.App.prepare',
    'demo.app.App.run',
    'demo.app.main',
    'demo.app.shout',
    'demo.engine.Engine.spin',
    'demo.engine.ignite',
  ],
  internalCall: ['demo.app.App.run', 'demo.app.shout', 'internal_func'],
  siblingCall: ['demo.app.App.run', 'demo.engine.ignite'],
  async: { 'demo.app.App.later': true, 'demo.app.App.run': false },
};

const SCALA: LanguageFixture = {
  files: {
    'demo/app.scala': `package demo

import demo.engine.Engine
import scala.math.max

class App(engine: Engine) {
  def run(): String = {
    prepare()
    this.prepare()
    ignite()
    max(1, 2)
    mystery()
    shout("x")
  }

  private def prepare(): String = "ready"
}

object Factory {
  def build(): App = new App(new Engine())
}

def shout(text: String): String = text
`,
    'demo/engine.scala': `package demo.engine

class Engine {
  def spin(): Int = 1
}

def ignite(): Int = 0
`,
  },
  functions: [
    'demo.app.App.prepare',
    'demo.app.App.run',
    'demo.app.Factory.build',
    'demo.app.shout',
    'demo.engine.Engine.spin',
    'demo.engine.ignite',
  ],
  internalCall: ['demo.app.App.run', 'demo.app.App.prepare', 'self_method'],
  siblingCall: ['demo.app.App.run', 'demo.engine.ignite'],
};

const ZIG: LanguageFixture = {
  files: {
    'app.zig': `const std = @import("std");

pub fn run() void {
    prepare();
    shout("x");
    ignite();
    mystery();
    std.debug.print("done", .{});
}

fn prepare() void {}

pub fn shout(text: []const u8) void {
    _ = text;
}
`,
    'engine.zig': `pub fn ignite() void {}
`,
  },
  functions: ['app.prepare', 'app.run', 'app.shout', 'engine.ignite'],
  internalCall: ['app.run', 'app.prepare', 'internal_func'],
  siblingCall: ['app.run', 'engine.ignite'],
};

const OBJC: LanguageFixture = {
  files: {
    'app.m': `#import <Foundation/Foundation.h>
#import "Logger.h"
#import "Engine.h"

@interface App : NSObject
- (void)run;
@end

@implementation App
- (void)run {
    [self prepare];
    [Logger warn];
    shout(@"x");
    ignite();
    NSLog(@"%@", @"hi");
}

- (void)prepare {
}
@end

void shout(NSString *text) {
    NSLog(@"%@", text);
}
`,
    'engine.m': `#import "Engine.h"

@implementation Engine
- (void)spin {
}
@end

void ignite(void) {
}
`,
  },
  functions: ['app.App.prepare', 'app.App.run', 'app.shout', 'engine.Engine.spin', 'engine.ignite'],
  internalCall: ['app.App.run', 'app.App.prepare', 'self_method'],
  siblingCall: ['app.App.run', 'engine.ignite'],
};

const OCAML: LanguageFixture = {
  files: {
    'app.ml': `open Logger

let prepare y = y

let run x =
  let y = shout x in
  let z = prepare y in
  Logger.warn z;
  String.length z
`,
    'helpers.ml': `let shout text = text
`,
  },
  // `let y = shout x` is the same node as `let prepare y = y`; only the one with
  // a parameter is a function, which is what `functionRequires` is for.
  functions: ['app.prepare', 'app.run', 'helpers.shout'],
  internalCall: ['app.run', 'app.prepare', 'internal_func'],
  siblingCall: ['app.run', 'helpers.shout'],
};

const FIXTURES: Record<string, LanguageFixture> = {
  kotlin: KOTLIN,
  scala: SCALA,
  zig: ZIG,
  objc: OBJC,
  ocaml: OCAML,
};

function writeFixture(prefix: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `hb-generic-${prefix}-`));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

function adapterFor(language: string): LanguageAdapter {
  const spec = GENERIC_LANGUAGES.find((s) => s.name === language);
  if (!spec) throw new Error(`${language} is not a configured generic language`);
  return createGenericAdapter(spec);
}

describe('configured generic languages', () => {
  it('every configured language has a fixture', () => {
    expect(GENERIC_LANGUAGES.map((s) => s.name).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it('declares the generic tier and no capability it cannot back up', () => {
    for (const spec of GENERIC_LANGUAGES) {
      const { capabilities } = createGenericAdapter(spec);
      expect(capabilities.tier).toBe('generic');
      expect(capabilities.selfAttrs).toBe(false);
      expect(capabilities.statementSpans).toBe(false);
      expect(capabilities.callTypes.filter((t) => !GENERIC_CALL_TYPES.includes(t))).toEqual([]);
    }
  });
});

describe.each(Object.keys(FIXTURES))('%s (generic engine)', (language) => {
  const fixture = FIXTURES[language];
  if (!fixture) throw new Error(`no fixture for ${language}`);
  const adapter = adapterFor(language);
  let analysis: ModuleAnalysis;
  let root: string;

  beforeAll(async () => {
    root = writeFixture(language, fixture.files);
    analysis = await adapter.analyze(Object.keys(fixture.files), root);
  });

  it('discovers its own files', () => {
    expect(adapter.discover(root).sort()).toEqual(Object.keys(fixture.files).sort());
  });

  it('extracts exactly the expected functions', () => {
    expect(analysis.functions.map((f) => f.id).sort()).toEqual([...fixture.functions].sort());
  });

  it('gives every function a sane line range and a signature', () => {
    for (const fn of analysis.functions) {
      expect(fn.lineStart).toBeGreaterThan(0);
      expect(fn.lineEnd).toBeGreaterThanOrEqual(fn.lineStart);
      const source = fixture.files[fn.file];
      expect(source, `${fn.id} points at an unknown file`).toBeDefined();
      expect(fn.lineEnd).toBeLessThanOrEqual((source ?? '').split('\n').length);
      expect(fn.signature.length).toBeGreaterThan(0);
      expect(fn.signature.length).toBeLessThanOrEqual(200);
      expect(fn.signature).not.toContain('\n');
    }
  });

  it('marks a method with its owner class', () => {
    for (const fn of analysis.functions) {
      expect(fn.isMethod).toBe(fn.className !== null);
      if (fn.className) expect(fn.qualname).toBe(`${fn.className}.${fn.name}`);
    }
  });

  it('resolves an internal call inside the fixture', () => {
    const [caller, callee, callType] = fixture.internalCall;
    const edge = analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
    expect(edge, `expected ${caller} -> ${callee}`).toBeDefined();
    expect(edge?.callType).toBe(callType);
  });

  it('resolves a bare call to a free function in a sibling file', () => {
    const [caller, callee] = fixture.siblingCall;
    const edge = analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
    expect(edge?.callType).toBe('internal_func');
  });

  it('points every internal edge at a function it extracted (or a constructor)', () => {
    const ids = new Set(analysis.functions.map((f) => f.id));
    const dangling = analysis.edges
      .filter((e) => e.callType === 'internal_func' || e.callType === 'self_method')
      .filter((e) => !ids.has(e.calleeId))
      .map((e) => e.calleeId);
    expect(dangling).toEqual([]);
  });

  it('never claims a callType that needs type inference', () => {
    const inferred = analysis.edges.filter(
      (e) => e.callType === 'self_attr_method' || e.callType === 'param_method',
    );
    expect(inferred).toEqual([]);
    expect(analysis.functions.flatMap((f) => Object.keys(f.paramTypes))).toEqual([]);
    expect(analysis.functions.flatMap((f) => [...f.selfAttrsRead, ...f.selfAttrsWritten])).toEqual([]);
  });

  it('produces exactly the callTypes it declares', () => {
    const produced = new Set(analysis.edges.map((e) => e.callType));
    const declared = new Set(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect(adapter.capabilities.callTypes.filter((t) => !produced.has(t)).sort()).toEqual([]);
  });

  it('reads async markers when the language has them', () => {
    for (const [id, expected] of Object.entries(fixture.async ?? {})) {
      expect(analysis.functions.find((f) => f.id === id)?.isAsync).toBe(expected);
    }
  });
});

describe('generic engine failure modes', () => {
  const KOTLIN_SOURCE = 'class A {\n    fun m(): Int = 1\n}\n';

  it('ignores a node type the grammar does not have instead of throwing', async () => {
    const adapter = createGenericAdapter({
      name: 'kotlin-bogus',
      grammar: 'kotlin',
      extensions: ['.kt'],
      nodes: {
        function: ['no_such_function_node'],
        class: ['no_such_class_node'],
        call: ['no_such_call_node'],
        import: ['no_such_import_node'],
      },
      callTypes: [],
    });
    const root = writeFixture('bogus', { 'a.kt': KOTLIN_SOURCE });
    const analysis = await adapter.analyze(['a.kt'], root);
    expect(analysis.functions).toEqual([]);
    expect(analysis.edges).toEqual([]);
  });

  it('skips a file it cannot read and keeps analyzing the rest', async () => {
    const adapter = adapterFor('kotlin');
    const root = writeFixture('unreadable', { 'good.kt': KOTLIN_SOURCE });
    const analysis = await adapter.analyze(['missing.kt', 'good.kt', 'nope/also-missing.kt'], root);
    expect(analysis.functions.map((f) => f.id)).toEqual(['good.A.m']);
  });

  it('skips a directory handed to it as a file', async () => {
    const adapter = adapterFor('kotlin');
    const root = writeFixture('isdir', { 'pkg/good.kt': KOTLIN_SOURCE });
    const analysis = await adapter.analyze(['pkg', 'pkg/good.kt'], root);
    expect(analysis.functions.map((f) => f.id)).toEqual(['pkg.good.A.m']);
  });

  it('survives a file that does not parse', async () => {
    const adapter = adapterFor('kotlin');
    const root = writeFixture('garbage', {
      'broken.kt': ' }}}} class ??? fun ((( ÿ\n',
      'good.kt': KOTLIN_SOURCE,
    });
    const analysis = await adapter.analyze(['broken.kt', 'good.kt'], root);
    // The broken file may yield nothing or a nonsense fragment; what matters is
    // that it neither throws nor costs us the file next to it.
    expect(analysis.functions.map((f) => f.id)).toContain('good.A.m');
  });

  it('keeps ids unique when two extensions collapse to one moduleId', async () => {
    const adapter = adapterFor('kotlin');
    const root = writeFixture('samestem', {
      'a.kt': 'fun f(): Int = 1\n',
      'a.kts': 'fun f(): Int = 2\n\nfun g(): Int = f()\n',
    });
    const analysis = await adapter.analyze(['a.kt', 'a.kts'], root);
    // `f` is declared twice under one moduleId: one node, and its caller's edge
    // is emitted once rather than once per duplicate.
    expect(analysis.functions.map((f) => f.id).sort()).toEqual(['a.f', 'a.g']);
    expect(analysis.edges.filter((e) => e.calleeId === 'a.f')).toHaveLength(1);
  });

  it('refuses a spec that claims a callType the engine cannot emit', () => {
    const spec = GENERIC_LANGUAGES.find((s) => s.name === 'kotlin');
    if (!spec) throw new Error('kotlin is not configured');
    expect(() => createGenericAdapter({ ...spec, callTypes: [...spec.callTypes, 'param_method'] })).toThrow(
      /param_method/,
    );
    expect(() => createGenericAdapter({ ...spec, callTypes: ['self_attr_method'] })).toThrow(
      /type inference/,
    );
  });

  it('resolves nothing rather than guessing when the callee is opaque', async () => {
    const adapter = adapterFor('objc');
    const root = writeFixture('opaque', {
      'a.m': `@implementation A
- (void)go {
    [[Engine alloc] init];
}
- (void)init2 {
}
@end

void init(void) {
}
`,
    });
    const analysis = await adapter.analyze(['a.m'], root);
    const opaque = analysis.edges.find((e) => e.raw.includes('alloc'));
    expect(opaque?.callType).toBe('unresolved');
    // The bare `init` free function must not have been mistaken for the target.
    expect(analysis.edges.some((e) => e.calleeId === 'a.init')).toBe(false);
  });
});

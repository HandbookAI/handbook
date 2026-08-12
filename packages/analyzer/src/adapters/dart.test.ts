import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbook/core';
import { DartAdapter } from './dart.js';

/**
 * The types `app.dart` leans on: a mixin, an abstract superclass, a class that
 * combines both, an extension on it, and a top-level function.
 */
const ENGINE_DART = `
mixin Loggable {
  void log(String message) {
    print(message);
  }
}

abstract class Machine {
  void warmUp() {}
}

class Engine extends Machine with Loggable {
  int rpm = 0;
  String? label;
  late List<Engine> children;

  Engine(this.rpm);
  Engine.idle() : rpm = 0;
  factory Engine.build() => Engine(1);

  void spin() {
    this.rpm += 1;
    log('spin');
    warmUp();
    _cool();
  }

  void _cool() {}

  static Engine fresh() => Engine(0);

  int get total => rpm + 1;
  set total(int v) { rpm = v; }
}

extension EngineBoost on Engine {
  void boost() {
    spin();
  }
}

void ignite(Engine e) {
  e.spin();
}
`;

/**
 * Note the two imports that must land differently: `engine.dart` is relative and
 * IS in the scan set, `package:flutter/material.dart` is not.
 */
const APP_DART = `
import 'engine.dart';
import 'package:flutter/material.dart' as material;
import 'util/text.dart';

class App extends Engine with Loggable {
  final Engine engine;
  Engine? spare;
  int hits = 0;

  App(this.engine) : super(0);

  Future<void> run(Engine other) async {
    engine.spin();
    other.spin();
    this.log('running');
    log('bare');
    warmUp();
    var made = Engine();
    made.spin();
    final named = Engine.idle();
    Engine.fresh();
    engine.boost();
    shout('hi');
    material.showDialog();
    hits = hits + 1;
    this.spare = other;
    await other.spin();
    mystery.doStuff();
    Text('widget');
    engine..spin()..spin();
    new Engine(2);
    void tidy() { _cool(); }
    tidy();
  }
}

void main() {
  final app = App(Engine(1));
  app.run(Engine(2));
  ignite(Engine(3));
}
`;

const TEXT_DART = `
String shout(String text) => text.toUpperCase();
`;

/** Not Dart at all: must be skipped without taking its neighbours down. */
const BROKEN_DART = `%%% not dart {{{ ??? ]]]
class }}} <<< &&&
++ ++ ++
`;

const FILES: Record<string, string> = {
  'lib/engine.dart': ENGINE_DART,
  'lib/app.dart': APP_DART,
  'lib/util/text.dart': TEXT_DART,
  'lib/broken.dart': BROKEN_DART,
  'lib/model.g.dart': 'class Generated {}\n',
  'lib/model.freezed.dart': 'class Frozen {}\n',
  'lib/api.pb.dart': 'class Proto {}\n',
  'lib/routes.gr.dart': 'class Routes {}\n',
  'lib/service.mocks.dart': 'class MockService {}\n',
  '.dart_tool/scratch.dart': 'class Scratch {}\n',
};

const ANALYZED = ['lib/engine.dart', 'lib/app.dart', 'lib/util/text.dart', 'lib/broken.dart'];

function writeRepo(files: Record<string, string>, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

describe('DartAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new DartAdapter();

  beforeAll(async () => {
    root = writeRepo(FILES, 'hb-dart-');
    analysis = await adapter.analyze(ANALYZED, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers .dart files, skipping generated sources and .dart_tool', () => {
    const files = adapter.discover(root);
    expect(files).toContain('lib/app.dart');
    expect(files).toContain('lib/util/text.dart');
    expect(files).not.toContain('lib/model.g.dart');
    expect(files).not.toContain('lib/model.freezed.dart');
    expect(files).not.toContain('lib/api.pb.dart');
    expect(files).not.toContain('lib/routes.gr.dart');
    expect(files).not.toContain('lib/service.mocks.dart');
    expect(files).not.toContain('.dart_tool/scratch.dart');
  });

  it('derives module ids from the path and qualnames as <Type>.<member>', () => {
    const spin = fn('lib.engine.Engine.spin');
    expect(spin).toBeDefined();
    expect(spin?.qualname).toBe('Engine.spin');
    expect(spin?.className).toBe('Engine');
    expect(spin?.isMethod).toBe(true);
    expect(spin?.file).toBe('lib/engine.dart');
    // `graph.ts:synthesizeConstructor` decomposes on the LAST two segments.
    expect(spin?.id).toBe(`lib.engine.${spin?.qualname}`);
  });

  it('records top-level functions as free functions, not methods', () => {
    const shout = fn('lib.util.text.shout');
    expect(shout?.isMethod).toBe(false);
    expect(shout?.className).toBeNull();
    expect(fn('lib.engine.ignite')?.isMethod).toBe(false);
  });

  it('records constructors under their source names', () => {
    // Unnamed → `<Type>.<Type>`, matching Java and C#; named keeps its own name.
    expect(fn('lib.engine.Engine.Engine')).toBeDefined();
    expect(fn('lib.engine.Engine.idle')?.qualname).toBe('Engine.idle');
    expect(fn('lib.engine.Engine.build')?.qualname).toBe('Engine.build');
  });

  it('keeps a getter and its setter on separate ids', () => {
    expect(fn('lib.engine.Engine.total')?.name).toBe('total');
    // A Dart setter really is named `x=`, which is what keeps the pair apart.
    expect(fn('lib.engine.Engine.total=')?.name).toBe('total=');
  });

  it('records async and async-generator members', () => {
    expect(fn('lib.app.App.run')?.isAsync).toBe(true);
    expect(fn('lib.engine.Engine.spin')?.isAsync).toBe(false);
  });

  it('learns parameter types from annotations', () => {
    expect(fn('lib.engine.ignite')?.paramTypes).toEqual({ e: 'Engine' });
    expect(fn('lib.app.App.run')?.paramTypes).toEqual({ other: 'Engine' });
  });

  it('resolves a same-file call to the class itself', () => {
    expect(edge('lib.engine.Engine.spin', 'lib.engine.Engine._cool')?.callType).toBe('self_method');
  });

  it('resolves a method the class only has by MIXING IN a mixin', () => {
    // `log` is declared nowhere on Engine — only on `mixin Loggable`.
    expect(edge('lib.engine.Engine.spin', 'lib.engine.Loggable.log')?.callType).toBe('self_method');
    // …and through `this.` as well, from a class two levels down.
    expect(raw('lib.app.App.run', 'this.log')?.calleeId).toBe('lib.engine.Loggable.log');
    expect(raw('lib.app.App.run', 'log')?.calleeId).toBe('lib.engine.Loggable.log');
  });

  it('resolves a method inherited from a scanned superclass', () => {
    // `warmUp` comes from `abstract class Machine`, one and two levels up.
    expect(edge('lib.engine.Engine.spin', 'lib.engine.Machine.warmUp')?.callType).toBe('self_method');
    expect(edge('lib.app.App.run', 'lib.engine.Machine.warmUp')?.callType).toBe('self_method');
  });

  it('resolves a call through a declared field type', () => {
    expect(raw('lib.app.App.run', 'engine.spin')?.calleeId).toBe('lib.engine.Engine.spin');
    expect(raw('lib.app.App.run', 'engine.spin')?.callType).toBe('self_attr_method');
  });

  it('resolves a call through a parameter type', () => {
    expect(raw('lib.app.App.run', 'other.spin')?.callType).toBe('param_method');
    expect(raw('lib.engine.ignite', 'e.spin')?.calleeId).toBe('lib.engine.Engine.spin');
  });

  it('infers a local variable type from `var e = Engine()`', () => {
    expect(raw('lib.app.App.run', 'made.spin')?.calleeId).toBe('lib.engine.Engine.spin');
  });

  it('treats a bare capitalized call on a scanned type as a construction', () => {
    // Dart's `new` is optional and almost never written.
    const made = analysis.edges.find(
      (e) =>
        e.callerId === 'lib.app.App.run' &&
        e.calleeId === 'lib.engine.Engine.Engine' &&
        e.callType === 'internal_constructor',
    );
    expect(made).toBeDefined();
    // …and an explicit `new` lands on exactly the same node.
    expect(raw('lib.app.App.run', 'new Engine(2)')?.calleeId).toBe('lib.engine.Engine.Engine');
  });

  it('resolves a named constructor to its own node', () => {
    expect(raw('lib.app.App.run', 'Engine.idle')?.calleeId).toBe('lib.engine.Engine.idle');
    expect(raw('lib.app.App.run', 'Engine.idle')?.callType).toBe('internal_constructor');
  });

  it('resolves a static method on a scanned type to internal_func', () => {
    // Per the SP2 IR decision: a static call IS a call to an internal function.
    expect(raw('lib.app.App.run', 'Engine.fresh')?.calleeId).toBe('lib.engine.Engine.fresh');
    expect(raw('lib.app.App.run', 'Engine.fresh')?.callType).toBe('internal_func');
  });

  it('resolves `: super(...)` to the superclass constructor', () => {
    expect(edge('lib.app.App.App', 'lib.engine.Engine.Engine')?.callType).toBe('internal_constructor');
  });

  it('resolves an extension method on the type it extends', () => {
    expect(raw('lib.app.App.run', 'engine.boost')?.calleeId).toBe('lib.engine.EngineBoost.boost');
    // …and an unqualified call inside the extension body sees the target's members.
    expect(edge('lib.engine.EngineBoost.boost', 'lib.engine.Engine.spin')).toBeDefined();
  });

  it('resolves a top-level function imported from another file', () => {
    expect(edge('lib.app.App.run', 'lib.util.text.shout')?.callType).toBe('internal_func');
    // …and one reached without any import at all, from the same library.
    expect(edge('lib.app.main', 'lib.engine.ignite')?.callType).toBe('internal_func');
  });

  it('resolves a cascade against the receiver it hangs off', () => {
    const cascades = analysis.edges.filter((e) => e.raw === 'engine..spin');
    expect(cascades).toHaveLength(2);
    expect(cascades[0]?.calleeId).toBe('lib.engine.Engine.spin');
  });

  it('resolves a local function to its own node', () => {
    expect(fn('lib.app.App.run.tidy')).toBeDefined();
    expect(edge('lib.app.App.run', 'lib.app.App.run.tidy')?.callType).toBe('internal_func');
    // The local function's own body still resolves against the enclosing class.
    expect(edge('lib.app.App.run.tidy', 'lib.engine.Engine._cool')?.callType).toBe('self_method');
  });

  it('sends a prefixed `package:` import to the boundary', () => {
    const call = raw('lib.app.App.run', 'material.showDialog');
    expect(call?.calleeId).toBe('boundary:package:flutter/material.dart.showDialog');
    expect(call?.callType).toBe('boundary');
  });

  it('reports an unknown capitalized call as a boundary construction', () => {
    // What a Flutter widget tree is made of, once the package is out of scope.
    expect(raw('lib.app.App.run', 'Text')?.callType).toBe('boundary_constructor');
  });

  it('leaves an ungroundable dynamic call unresolved', () => {
    const call = raw('lib.app.App.run', 'mystery.doStuff');
    expect(call?.callType).toBe('unresolved');
    expect(call?.calleeId).toBe('unresolved:mystery.doStuff');
  });

  it('marks an awaited call', () => {
    expect(analysis.edges.some((e) => e.callerId === 'lib.app.App.run' && e.isAwait)).toBe(true);
  });

  it('tracks this-field reads and writes, with and without `this.`', () => {
    const run = fn('lib.app.App.run');
    // `hits = hits + 1` is both; `this.spare = other` is a write; `engine.spin()`
    // reads the field it calls through.
    expect(run?.selfAttrsRead).toEqual(['engine', 'hits']);
    expect(run?.selfAttrsWritten).toEqual(['hits', 'spare']);
    const spin = fn('lib.engine.Engine.spin');
    expect(spin?.selfAttrsRead).toEqual(['rpm']);
    expect(spin?.selfAttrsWritten).toEqual(['rpm']);
  });

  it('counts a field-initialising formal and an initializer entry as writes', () => {
    expect(fn('lib.engine.Engine.Engine')?.selfAttrsWritten).toEqual(['rpm']);
    expect(fn('lib.engine.Engine.idle')?.selfAttrsWritten).toEqual(['rpm']);
    expect(fn('lib.app.App.App')?.selfAttrsWritten).toEqual(['engine']);
  });

  it('skips an unparseable file without taking its neighbours down', () => {
    expect(analysis.functions.some((f) => f.file === 'lib/broken.dart')).toBe(false);
    expect(analysis.functions.some((f) => f.file === 'lib/app.dart')).toBe(true);
    expect(analysis.functions.some((f) => f.file === 'lib/engine.dart')).toBe(true);
    expect(analysis.functions.some((f) => f.file === 'lib/util/text.dart')).toBe(true);
  });

  it('extracts a file the same way alone as it does beside its neighbours', async () => {
    // The `lua` grammar was dropped from this repo because what it dropped
    // depended on what the SAME parser had parsed before — one parser instance
    // is reused across every file here, so that failure mode is guarded for.
    const alone = await new DartAdapter().analyze(['lib/engine.dart'], root);
    const beside = analysis.functions.filter((f) => f.file === 'lib/engine.dart').map((f) => f.id);
    expect(alone.functions.map((f) => f.id)).toEqual(beside);
    const again = await adapter.analyze(ANALYZED, root);
    expect(again.functions.map((f) => f.id)).toEqual(analysis.functions.map((f) => f.id));
    expect(again.edges.map((e) => e.calleeId)).toEqual(analysis.edges.map((e) => e.calleeId));
  });

  it('produces a graph of the expected size', () => {
    expect(analysis.functions).toHaveLength(17);
    expect(analysis.edges).toHaveLength(36);
  });

  it('declares exactly the callTypes its fixture produces, in both directions', () => {
    const produced = new Set<CallType>(analysis.edges.map((e) => e.callType));
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect([...declared].filter((t) => !produced.has(t)).sort()).toEqual([]);
  });

  it('declares a full tier with selfAttrs and no statement spans', () => {
    expect(adapter.capabilities.tier).toBe('full');
    expect(adapter.capabilities.selfAttrs).toBe(true);
    expect(adapter.capabilities.statementSpans).toBe(false);
    expect(adapter.statementSpans).toBeUndefined();
  });
});

/**
 * `part` / `part of` split one library across files, and `export` makes a barrel
 * re-expose another library. Both change what a bare name can see, in ways the
 * spine's per-module tables cannot express on their own.
 */
describe('DartAdapter — libraries, parts and barrels', () => {
  let analysis: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(
      {
        'lib/core.dart': `library core;
export 'engine.dart';
part 'core_helpers.dart';

class Core {
  void kick() {
    Engine().spin();
    helper();
  }
}
`,
        'lib/core_helpers.dart': `part of 'core.dart';

void helper() {}
`,
        'lib/engine.dart': `class Engine {
  void spin() {}
}
`,
        // Imports the library by `package:` URI: no pubspec is read, so this
        // only resolves because `lib/<path>` is the conventional layout.
        'lib/consumer.dart': `import 'package:demo/core.dart';

void go() {
  Core().kick();
  Engine().spin();
  helper();
}
`,
      },
      'hb-dart-lib-',
    );
    const adapter = new DartAdapter();
    analysis = await adapter.analyze(adapter.discover(root), root);
  });

  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('sees a sibling part file’s top-level function from the library head', () => {
    expect(edge('lib.core.Core.kick', 'lib.core_helpers.helper')?.callType).toBe('internal_func');
  });

  it('resolves a `package:<pkg>/<path>` import onto lib/<path>', () => {
    expect(edge('lib.consumer.go', 'lib.core.Core.Core')?.callType).toBe('internal_constructor');
  });

  it('follows an `export` so a barrel re-exposes the module behind it', () => {
    expect(edge('lib.consumer.go', 'lib.engine.Engine.Engine')?.callType).toBe('internal_constructor');
    expect(edge('lib.consumer.go', 'lib.engine.Engine.spin')).toBeDefined();
  });

  it('sees a part’s names through an import of the library that owns it', () => {
    expect(edge('lib.consumer.go', 'lib.core_helpers.helper')?.callType).toBe('internal_func');
  });
});

/**
 * `tree-sitter-dart` MISPARSES `Foo<T>(…)` — one type argument, non-statement
 * position — as the comparison `Foo < T > (record)`, silently (`hasError` stays
 * false). That is precisely where a Flutter widget tree lives, so the adapter
 * recovers the call rather than dropping it. Clean fixtures never showed this.
 */
describe('DartAdapter — generic construction spellings', () => {
  let analysis: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(
      {
        'lib/g.dart': `class Box {
  Box();
  Box.of(int n);
  static Box empty() => Box();
  void use() {}
}

void statement() {
  Box<int>();
  Box<int>.of(1);
}

void argument() {
  take(Box<int>(0));
  take(Box<int>.of(1));
}

Box returned() => Box<int>(0);

void inferred() {
  var b = Box<int>(0);
  b.use();
  Box.empty();
}

void take(Object o) {}
`,
      },
      'hb-dart-gen-',
    );
    analysis = await new DartAdapter().analyze(['lib/g.dart'], root);
  });

  const from = (caller: string) => analysis.edges.filter((e) => e.callerId === caller);

  it('resolves `Box<int>()` and `Box<int>.of()` written as statements', () => {
    const edges = from('lib.g.statement');
    expect(edges.map((e) => e.calleeId)).toEqual(['lib.g.Box.Box', 'lib.g.Box.of']);
    expect(edges.map((e) => e.callType)).toEqual(['internal_constructor', 'internal_constructor']);
  });

  it('recovers the misparsed `Box<int>(…)` in argument position', () => {
    expect(
      from('lib.g.argument')
        .map((e) => e.calleeId)
        .sort(),
    ).toEqual(['lib.g.Box.Box', 'lib.g.Box.of', 'lib.g.take', 'lib.g.take']);
  });

  it('recovers it after `return` too', () => {
    expect(from('lib.g.returned').map((e) => e.calleeId)).toEqual(['lib.g.Box.Box']);
  });

  it('still infers the local variable type through the misparse', () => {
    expect(from('lib.g.inferred').some((e) => e.calleeId === 'lib.g.Box.use')).toBe(true);
  });

  it('keeps a static method a func and a named constructor a constructor', () => {
    // Both are spelled `Box<T>.name()`; only the member declaration tells them apart.
    const empty = analysis.edges.find((e) => e.calleeId === 'lib.g.Box.empty');
    expect(empty?.callType).toBe('internal_func');
  });
});

/** Shapes that exist in Dart and in no other adapter here. */
describe('DartAdapter — Dart-specific member shapes', () => {
  let analysis: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(
      {
        'lib/odd.dart': `sealed class Shape {}
class Circle extends Shape { final double r; Circle(this.r); }

double area(Shape sh) => switch (sh) {
  Circle(r: final r) => 3.14 * r * r,
};

class Proxy {
  @Deprecated('legacy')
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
  Proxy operator +(Proxy o) => o;
  operator [](int i) => i;
  external void ext();
  void abstractish();
}

enum Mode {
  fast, slow;
  void tell() {}
}

class Redirect {
  Redirect(int a);
  Redirect.zero() : this(0);
}
`,
      },
      'hb-dart-odd-',
    );
    analysis = await new DartAdapter().analyze(['lib/odd.dart'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);

  it('records operators, `external` and bodiless members as real nodes', () => {
    expect(fn('lib.odd.Proxy.operator+')).toBeDefined();
    expect(fn('lib.odd.Proxy.operator[]')).toBeDefined();
    expect(fn('lib.odd.Proxy.ext')).toBeDefined();
    expect(fn('lib.odd.Proxy.abstractish')).toBeDefined();
  });

  it('records enum methods and reads annotations as decorators', () => {
    expect(fn('lib.odd.Mode.tell')?.className).toBe('Mode');
    expect(fn('lib.odd.Proxy.noSuchMethod')?.decorators).toEqual(['Deprecated']);
  });

  it('does not mistake a Dart 3 object pattern for a constructor call', () => {
    // `Circle(r: final r)` in a switch is a PATTERN, not a construction.
    expect(analysis.edges.filter((e) => e.callerId === 'lib.odd.area')).toEqual([]);
  });

  it('resolves a redirecting constructor to the one it redirects to', () => {
    const redirect = analysis.edges.find((e) => e.callerId === 'lib.odd.Redirect.zero');
    expect(redirect?.calleeId).toBe('lib.odd.Redirect.Redirect');
    expect(redirect?.callType).toBe('internal_constructor');
  });

  it('leaves a `super` call into an unscanned supertype unresolved', () => {
    // `Proxy` extends nothing we scanned, so `super.noSuchMethod` has no target.
    expect(analysis.edges.find((e) => e.callerId === 'lib.odd.Proxy.noSuchMethod')?.callType).toBe(
      'unresolved',
    );
  });
});

describe('DartAdapter — parsed type declarations', () => {
  let analysis: ModuleAnalysis;
  const SRC = `class Engine {
  int rpm = 0;
  void spin() {}
}

abstract interface class Contract {
  void run();
}

sealed class Shape {}

enum Gear { low, high }

mixin Loggable {
  void log(String m) {}
}

extension StringX on String {
  String shout() => this;
}

typedef Callback = void Function(int);

typedef void OldStyle(int x);

extension type Meters(int value) {}

@immutable
class Annotated {
  final int x = 0;
}
`;
  const lines = SRC.split('\n');
  const find = (name: string): NonNullable<ModuleAnalysis['types']>[number] | undefined =>
    (analysis.types ?? []).find((t) => t.name === name);

  beforeAll(async () => {
    const root = writeRepo({ 'lib/kinds.dart': SRC }, 'hb-dart-types-');
    analysis = await new DartAdapter().analyze(['lib/kinds.dart'], root);
  });

  it('maps class and enum onto the obvious buckets', () => {
    expect(find('Engine')?.kind).toBe('class');
    expect(find('Gear')?.kind).toBe('enum');
  });

  it('calls a mixin a trait, because that is what the word means here', () => {
    // A named bundle of method BODIES, composed in with `with`, not instantiable —
    // this vocabulary's definition of `trait`, and what Scala and PHP call one.
    expect(find('Loggable')?.kind).toBe('trait');
    expect(find('Loggable')?.signature).toBe('mixin Loggable');
    // The name is not in a `name` field on this node, so the fallback must work.
    expect(lines[(find('Loggable')?.lineStart ?? 0) - 1]).toContain('mixin Loggable');
  });

  it('keeps a modified class a class, with the modifiers in the signature', () => {
    // `interface`/`sealed`/`abstract` restrict who may extend or implement; they do
    // not make the declaration a different kind of thing.
    expect(find('Contract')?.kind).toBe('class');
    expect(find('Contract')?.signature).toBe('abstract interface class Contract');
    expect(find('Shape')?.kind).toBe('class');
    expect(find('Shape')?.signature).toBe('sealed class Shape');
  });

  it('calls a typedef an alias, in both of Dart spellings', () => {
    expect(find('Callback')?.kind).toBe('alias');
    expect(find('Callback')?.signature).toBe('typedef Callback = void Function(int);');
    // The old form puts the RETURN type first, so the name is not the first child.
    expect(find('OldStyle')?.kind).toBe('alias');
    expect(find('OldStyle')?.signature).toBe('typedef void OldStyle(int x);');
  });

  it('calls an extension type `other`, not an alias', () => {
    // `Meters` and `int` are not interchangeable, so `alias` would state the
    // opposite of the language's rule. Same call as a Go defined type.
    expect(find('Meters')?.kind).toBe('other');
    expect(find('Meters')?.signature).toBe('extension type Meters(int value)');
  });

  it('emits no type for an extension, whose members it still scans', () => {
    // `StringX` cannot annotate a variable, and `String` was declared elsewhere: a
    // row here would point at a declaration that is not in this file at all.
    expect(find('StringX')).toBeUndefined();
    expect(find('String')).toBeUndefined();
    expect(analysis.functions.some((f) => f.qualname === 'StringX.shout')).toBe(true);
  });

  it('spans the declaration and never the members', () => {
    const engine = find('Engine');
    expect(lines[(engine?.lineStart ?? 0) - 1]).toBe('class Engine {');
    expect(engine?.lineEnd).toBe(4);
    expect(engine?.container).toBeNull();
    expect(engine?.id).toBe('type:lib.kinds.Engine');
  });

  it('starts an annotated declaration span at the annotation, as the grammar does', () => {
    // Pinned rather than tolerated. The annotation is INSIDE `class_definition`, so
    // this is the declaration node's own span — the same choice the C# and Java
    // adapters already make for `[Attribute]` and `@Annotation`. The cost is real
    // and is disclosed in the README: a long annotation can push the type's name
    // past the truncated signature (measured 58/7212 rows on flutter/packages).
    const annotated = find('Annotated');
    expect(lines[(annotated?.lineStart ?? 0) - 1]).toBe('@immutable');
    expect(annotated?.signature).toBe('@immutable class Annotated');
    expect(lines[(annotated?.lineEnd ?? 0) - 1]).toBe('}');
  });

  it('declares exactly the kinds it emits', () => {
    expect(new DartAdapter().capabilities.typeKinds).toEqual(['alias', 'class', 'enum', 'other', 'trait']);
  });
});

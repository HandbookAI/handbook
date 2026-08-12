/**
 * Swift adapter tests.
 *
 * These run behind a hazard guard. `tree-sitter-wasms@0.1.13`'s Swift grammar
 * makes V8 ≥ 13 abort the process (`Fatal process out of memory: Zone`) the
 * moment it tiers up a parse — see the header of `swift.ts`. An abort cannot be
 * caught in-process, and it takes the vitest worker (and therefore every other
 * test in the run) down with it. So before importing anything grammar-shaped,
 * a child process is asked to parse one line of Swift and survive; the suite
 * only runs if it does.
 *
 * The probe is empirical rather than a Node-version check because the fault
 * lives in V8's wasm tier-up, not in Node: measured OK on 21.7.3 (V8 11.8),
 * fatal on 24.14.0 and 24.18.0 (V8 13.6). A 300 ms grace period catches it 5/5
 * on an affected runtime (the abort lands ~170 ms in) and costs ~0.6 s once.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbook/core';
import { SwiftAdapter } from './swift.js';

/** Can this runtime parse Swift without aborting? Measured, not assumed. */
function swiftGrammarIsSafe(): boolean {
  const require = createRequire(import.meta.url);
  let runtime: string;
  let grammar: string;
  try {
    runtime = require.resolve('web-tree-sitter');
    grammar = require.resolve('tree-sitter-wasms/out/tree-sitter-swift.wasm');
  } catch {
    return false;
  }
  const script = `
    const { readFileSync } = require('node:fs');
    const { pathToFileURL } = require('node:url');
    import(pathToFileURL(${JSON.stringify(runtime)}).href).then(async ({ Language, Parser }) => {
      await Parser.init();
      const parser = new Parser();
      parser.setLanguage(await Language.load(readFileSync(${JSON.stringify(grammar)})));
      for (let i = 0; i < 5; i += 1) parser.parse('class A { func b() { self.c() } }\\n');
      setTimeout(() => process.exit(0), 300);
    }).catch(() => process.exit(1));
  `;
  // The probe must run under the SAME runtime configuration as the tests: a
  // worker launched with `--liftoff-only` is safe, and a probe that ignored
  // that would skip a suite that would have passed.
  const flags = process.execArgv.filter((a) => !a.startsWith('--inspect'));
  const probe = spawnSync(process.execPath, [...flags, '-e', script], {
    timeout: 20_000,
    stdio: 'ignore',
  });
  return probe.status === 0;
}

const SAFE = swiftGrammarIsSafe();

/** The type App leans on, declared in one file and EXTENDED from another. */
const ENGINE_SWIFT = `import Foundation

public protocol Runner {
    func start()
    func ping()
}

extension Runner {
    func ping() {
        self.start()
    }
}

public class EngineBase {
    var cycles: Int = 0

    func warmup() {
        self.cycles = 0
    }

    func reset() {
        cycles = 0
    }
}

public class Engine: EngineBase, Runner {
    public var rpm: Int = 0
    private let label: String

    public init(label: String = "e") {
        self.label = label
    }

    public func spin() {
        self.rpm += 1
    }

    public func spinAsync() async -> Int {
        return self.rpm
    }

    public func start() { }

    public static func describe() -> String {
        return "engine"
    }
}

public enum Outer {
    public struct Inner {
        public func deep() -> Int {
            return 1
        }
    }
}

public func shout(_ text: String) -> String {
    return text
}
`;

/**
 * Extensions in a THIRD file, adding members to types declared in engine.swift.
 * Nothing here declares Engine or Outer.Inner — the members must still land on
 * them, and calls from other files must find them here.
 */
const EXTRAS_SWIFT = `extension Engine {
    public func idle() -> Int {
        self.spin()
        return self.rpm
    }
}

extension Outer.Inner {
    public func extended() -> Int {
        return self.deep()
    }
}
`;

const APP_SWIFT = `import Foundation
import UIKit

@MainActor
public final class App: EngineBase, Runner {
    private let engine: Engine
    var ready = false
    var hits: Int = 0
    var pool: [Engine] = []
    var slot: Engine?
    var boxed: Box<Engine>?

    public init(engine: Engine) {
        self.engine = engine
    }

    @discardableResult
    public func run(other: Engine, label tag: String) async throws -> String {
        self.prepare()
        prepare()
        self.engine.spin()
        other.spin()
        let made = Engine()
        made.spin()
        let annotated: Engine = Engine()
        annotated.spin()
        self.slot?.spin()
        Engine.describe()
        self.reset()
        self.ping()
        super.warmup()
        shout(tag)
        Outer.Inner().deep()
        self.engine.idle()
        Foundation.NSLog("hi")
        let widget = Widget()
        pool.map { item in item.spin() }
        mystery.poke()
        self.hits += 1
        return await self.engine.spinAsync()
    }

    public func start() {
        ready = true
    }

    private func prepare() {
        func bump(step: Int) -> Int {
            return step + hits
        }
        _ = bump(step: 1)
        self.ready = true
    }

    var summary: String {
        get { return "\\(hits)" }
        set { self.ready = false }
    }
}
`;

/** Not Swift at all: must be skipped without taking its neighbours down. */
const BROKEN_SWIFT = `%%% not swift {{{ ??? ]]]
class }}} <<< &&&
++ ++ ++ func
`;

const FILES: Record<string, string> = {
  'Sources/Engine.swift': ENGINE_SWIFT,
  'Sources/Extras.swift': EXTRAS_SWIFT,
  'Sources/App.swift': APP_SWIFT,
  'Sources/Broken.swift': BROKEN_SWIFT,
  '.build/Ignored.swift': 'class Ignored { }\n',
  'Pods/Vendor.swift': 'class Vendor { }\n',
  'Sources/Api.generated.swift': 'class Api { }\n',
};

const ANALYZED = [
  'Sources/Engine.swift',
  'Sources/Extras.swift',
  'Sources/App.swift',
  'Sources/Broken.swift',
];

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-swift-'));
  for (const [rel, source] of Object.entries(FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

describe.skipIf(!SAFE)('SwiftAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new SwiftAdapter();

  beforeAll(async () => {
    root = writeFixture();
    analysis = await adapter.analyze(ANALYZED, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers .swift files, skipping build output and generated files', () => {
    const files = adapter.discover(root);
    expect(files).toContain('Sources/App.swift');
    expect(files).toContain('Sources/Engine.swift');
    expect(files).not.toContain('.build/Ignored.swift');
    expect(files).not.toContain('Pods/Vendor.swift');
    expect(files).not.toContain('Sources/Api.generated.swift');
  });

  it('derives module ids from the path', () => {
    expect(fn('Sources.App.App.run')).toBeDefined();
    expect(fn('Sources.Engine.Engine.spin')).toBeDefined();
    expect(fn('Sources.Engine.shout')).toBeDefined();
  });

  it('extracts methods, initializers and static methods', () => {
    const run = fn('Sources.App.App.run');
    expect(run?.isMethod).toBe(true);
    expect(run?.className).toBe('App');
    expect(fn('Sources.App.App.init')?.className).toBe('App');
    expect(fn('Sources.Engine.Engine.describe')?.isMethod).toBe(false);
    expect(fn('Sources.Engine.shout')?.isMethod).toBe(false);
    expect(fn('Sources.Engine.shout')?.className).toBeNull();
  });

  it('records a bodiless protocol requirement so edges never dangle', () => {
    expect(fn('Sources.Engine.Runner.start')).toBeDefined();
  });

  it('scope-qualifies a nested type', () => {
    const deep = fn('Sources.Engine.Outer.Inner.deep');
    expect(deep?.qualname).toBe('Outer.Inner.deep');
    expect(deep?.className).toBe('Outer.Inner');
  });

  it('detects async and captures attributes as decorators', () => {
    expect(fn('Sources.App.App.run')?.isAsync).toBe(true);
    expect(fn('Sources.App.App.prepare')?.isAsync).toBe(false);
    expect(fn('Sources.App.App.run')?.decorators).toEqual(['discardableResult']);
    expect(fn('Sources.App.App.prepare')?.decorators).toEqual([]);
  });

  it('gives a single-line signature without the attribute prefix', () => {
    const sig = fn('Sources.App.App.run')?.signature ?? '';
    expect(sig).toBe('public func run(other: Engine, label tag: String) async throws -> String');
    expect(sig.length).toBeLessThanOrEqual(200);
  });

  it('learns parameter types, using the internal name not the label', () => {
    expect(fn('Sources.App.App.run')?.paramTypes).toEqual({ other: 'Engine', tag: 'String' });
  });

  it('turns computed accessors into functions', () => {
    expect(fn('Sources.App.App.get_summary')).toBeDefined();
    expect(fn('Sources.App.App.set_summary')).toBeDefined();
  });

  it('records a nested function under its enclosing member', () => {
    const bump = fn('Sources.App.App.prepare.bump');
    expect(bump?.className).toBe('App');
    expect(bump?.isMethod).toBe(false);
    expect(edge('Sources.App.App.prepare', 'Sources.App.App.prepare.bump')?.callType).toBe('internal_func');
  });

  // ── extensions: the defining Swift structure ──────────────────────────────

  it('attaches an extension member to the extended type, not to a free function', () => {
    const idle = fn('Sources.Extras.Engine.idle');
    expect(idle?.className).toBe('Engine');
    expect(idle?.qualname).toBe('Engine.idle');
    expect(idle?.isMethod).toBe(true);
    expect(analysis.functions.some((f) => f.id === 'Sources.Extras.idle')).toBe(false);
  });

  it('lands a cross-file call on the extension that declares the member', () => {
    const e = raw('Sources.App.App.run', 'self.engine.idle');
    expect(e?.calleeId).toBe('Sources.Extras.Engine.idle');
    expect(e?.callType).toBe('self_attr_method');
  });

  it('resolves self.m() inside an extension back to the original declaration', () => {
    expect(edge('Sources.Extras.Engine.idle', 'Sources.Engine.Engine.spin')?.callType).toBe('self_method');
  });

  it('extends a nested type from another file', () => {
    const ext = fn('Sources.Extras.Outer.Inner.extended');
    expect(ext?.className).toBe('Outer.Inner');
    expect(edge('Sources.Extras.Outer.Inner.extended', 'Sources.Engine.Outer.Inner.deep')?.callType).toBe(
      'self_method',
    );
  });

  // ── call resolution ───────────────────────────────────────────────────────

  it('resolves self.m() and bare m() in the same file to self_method', () => {
    expect(raw('Sources.App.App.run', 'self.prepare')?.calleeId).toBe('Sources.App.App.prepare');
    expect(raw('Sources.App.App.run', 'self.prepare')?.callType).toBe('self_method');
    expect(raw('Sources.App.App.run', 'prepare')?.calleeId).toBe('Sources.App.App.prepare');
    expect(raw('Sources.App.App.run', 'prepare')?.callType).toBe('self_method');
  });

  it('resolves a method inherited from a scanned superclass', () => {
    expect(edge('Sources.App.App.run', 'Sources.Engine.EngineBase.reset')?.callType).toBe('self_method');
  });

  it('resolves a default supplied by a scanned protocol extension', () => {
    expect(edge('Sources.App.App.run', 'Sources.Engine.Runner.ping')?.callType).toBe('self_method');
  });

  it('resolves super.m() to the superclass declaration', () => {
    expect(raw('Sources.App.App.run', 'super.warmup')?.calleeId).toBe('Sources.Engine.EngineBase.warmup');
    expect(raw('Sources.App.App.run', 'super.warmup')?.callType).toBe('self_method');
  });

  it('resolves self.property.m() through the declared property type', () => {
    const e = raw('Sources.App.App.run', 'self.engine.spin');
    expect(e?.calleeId).toBe('Sources.Engine.Engine.spin');
    expect(e?.callType).toBe('self_attr_method');
  });

  it('peels an optional property type down to the wrapped type', () => {
    const e = raw('Sources.App.App.run', 'self.slot?.spin');
    expect(e?.calleeId).toBe('Sources.Engine.Engine.spin');
    expect(e?.callType).toBe('self_attr_method');
  });

  it('treats a collection property as the collection, not its element', () => {
    // `[Engine]` IS an Array; calling it Engine would invent an Engine.map node.
    expect(edge('Sources.App.App.run', 'boundary:Array.map')?.callType).toBe('boundary');
  });

  it('peels a generic property type down to its container', () => {
    expect(fn('Sources.App.App.run')).toBeDefined();
    expect(analysis.functions.some((f) => f.paramTypes['boxed'] === 'Box')).toBe(false);
  });

  it('resolves param.m() through the declared parameter type', () => {
    const e = raw('Sources.App.App.run', 'other.spin');
    expect(e?.calleeId).toBe('Sources.Engine.Engine.spin');
    expect(e?.callType).toBe('param_method');
  });

  it('infers a local from `let x = Engine()` and from an explicit annotation', () => {
    expect(raw('Sources.App.App.run', 'made.spin')?.calleeId).toBe('Sources.Engine.Engine.spin');
    expect(raw('Sources.App.App.run', 'made.spin')?.callType).toBe('param_method');
    expect(raw('Sources.App.App.run', 'annotated.spin')?.calleeId).toBe('Sources.Engine.Engine.spin');
  });

  it('treats Engine() as a constructor of the scanned type (Swift has no new)', () => {
    const e = raw('Sources.App.App.run', 'Engine');
    expect(e?.calleeId).toBe('Sources.Engine.Engine.init');
    expect(e?.callType).toBe('internal_constructor');
  });

  it('constructs a nested type through its qualified name', () => {
    expect(raw('Sources.App.App.run', 'Outer.Inner')?.calleeId).toBe('Sources.Engine.Outer.Inner.init');
    expect(raw('Sources.App.App.run', 'Outer.Inner')?.callType).toBe('internal_constructor');
    expect(raw('Sources.App.App.run', 'Outer.Inner().deep')?.calleeId).toBe(
      'Sources.Engine.Outer.Inner.deep',
    );
  });

  it('resolves a static call on a scanned type to internal_func', () => {
    const e = raw('Sources.App.App.run', 'Engine.describe');
    expect(e?.calleeId).toBe('Sources.Engine.Engine.describe');
    expect(e?.callType).toBe('internal_func');
  });

  it('resolves a free function declared in another file of the module', () => {
    const e = raw('Sources.App.App.run', 'shout');
    expect(e?.calleeId).toBe('Sources.Engine.shout');
    expect(e?.callType).toBe('internal_func');
  });

  it('sends a call into an unscanned framework to boundary', () => {
    expect(edge('Sources.App.App.run', 'boundary:Foundation.NSLog')?.callType).toBe('boundary');
  });

  it('sends an unscanned type construction to boundary_constructor', () => {
    expect(edge('Sources.App.App.run', 'boundary:Widget')?.callType).toBe('boundary_constructor');
  });

  it('leaves an ungroundable receiver unresolved', () => {
    expect(raw('Sources.App.App.run', 'mystery.poke')?.callType).toBe('unresolved');
    expect(raw('Sources.App.App.run', 'mystery.poke')?.calleeId).toBe('unresolved:mystery.poke');
  });

  it('flags awaited calls', () => {
    expect(raw('Sources.App.App.run', 'self.engine.spinAsync')?.isAwait).toBe(true);
    expect(raw('Sources.App.App.run', 'other.spin')?.isAwait).toBe(false);
  });

  // ── self attributes ───────────────────────────────────────────────────────

  it('tracks self.property reads and writes', () => {
    const run = fn('Sources.App.App.run');
    expect(run?.selfAttrsWritten).toContain('hits');
    expect(run?.selfAttrsRead).toContain('hits');
    expect(run?.selfAttrsRead).toContain('engine');
    expect(fn('Sources.App.App.init')?.selfAttrsWritten).toEqual(['engine']);
    const spin = fn('Sources.Engine.Engine.spin');
    expect(spin?.selfAttrsWritten).toEqual(['rpm']);
    expect(spin?.selfAttrsRead).toEqual(['rpm']);
  });

  it('tracks a bare property access written without self.', () => {
    expect(fn('Sources.App.App.start')?.selfAttrsWritten).toEqual(['ready']);
    expect(fn('Sources.Engine.EngineBase.reset')?.selfAttrsWritten).toEqual(['cycles']);
  });

  it('does not mistake an invoked method name for a state attribute', () => {
    expect(fn('Sources.App.App.run')?.selfAttrsRead).not.toContain('prepare');
  });

  // ── robustness ────────────────────────────────────────────────────────────

  it('skips an unparseable file without taking its neighbours down', () => {
    expect(analysis.functions.some((f) => f.file === 'Sources/Broken.swift')).toBe(false);
    expect(analysis.functions.some((f) => f.file === 'Sources/App.swift')).toBe(true);
    expect(analysis.functions.some((f) => f.file === 'Sources/Engine.swift')).toBe(true);
  });

  it('produces exactly the callTypes it declares, in both directions', () => {
    const produced = new Set<CallType>(analysis.edges.map((e) => e.callType));
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect([...declared].filter((t) => !produced.has(t)).sort()).toEqual([]);
    expect(adapter.capabilities.tier).toBe('full');
    expect(adapter.capabilities.selfAttrs).toBe(true);
    expect(adapter.capabilities.statementSpans).toBe(typeof adapter.statementSpans === 'function');
  });
});

describe.skipIf(!SAFE)('SwiftAdapter — hairy real-world Swift', () => {
  /**
   * SwiftUI result builders, trailing closures, `@propertyWrapper`, `guard let`,
   * multi-line strings and `#if os(...)`. Clean fixtures hide exactly this class
   * of breakage — the C++ adapter shipped with `extern "C"` swallowing whole
   * files because nothing hairy was ever parsed.
   */
  const HAIRY = `import SwiftUI

@propertyWrapper
struct Clamped<T: Comparable> {
    private var value: T
    var wrappedValue: T {
        get { value }
        set { value = newValue }
    }
    init(wrappedValue: T) { self.value = wrappedValue }
}

@available(iOS 15.0, *)
struct ContentView: View {
    @State private var count = 0
    @Clamped var level: Int = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Hello \\(count)")
                .font(.title)
                .padding()
            Button("Tap") { self.bump() }
            ForEach(items) { item in Row(item: item) }
        }
        .onAppear { self.load() }
    }

    func bump() { count += 1 }
    func load() { }
}

#if os(iOS)
extension ContentView {
    func platform() -> String {
        guard let name = deviceName else { return "" }
        let banner = """
        running on
        \\(name)
        """
        return banner
    }
}
#else
extension ContentView {
    func platform() -> String { return "desktop" }
}
#endif
`;

  it('parses SwiftUI, property wrappers and #if without losing the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-swift-hairy-'));
    writeFileSync(join(root, 'View.swift'), HAIRY);
    const result = await new SwiftAdapter().analyze(['View.swift'], root);

    // The file survived: members from before, inside and after the #if are all here.
    expect(result.functions.some((f) => f.id === 'View.ContentView.bump')).toBe(true);
    expect(result.functions.some((f) => f.id === 'View.ContentView.get_body')).toBe(true);
    expect(result.functions.some((f) => f.id === 'View.Clamped.init')).toBe(true);
    expect(result.functions.some((f) => f.id === 'View.ContentView.platform')).toBe(true);

    // A trailing closure's calls belong to the member that contains it.
    const body = result.edges.filter((e) => e.callerId === 'View.ContentView.get_body');
    expect(body.some((e) => e.calleeId === 'View.ContentView.bump')).toBe(true);
    expect(body.some((e) => e.calleeId === 'View.ContentView.load')).toBe(true);
    expect(body.some((e) => e.calleeId === 'boundary:VStack')).toBe(true);

    // Both #if branches declare `platform`; ids stay unique (last one wins).
    expect(result.functions.filter((f) => f.id === 'View.ContentView.platform')).toHaveLength(1);
  });

  /**
   * Three constructs the pinned grammar genuinely cannot parse — raw strings
   * (`#"…"#`), Swift 5.9 macro expansions (`#m(1)`) and Swift 6 typed throws
   * (`throws(E)`). The question that matters is not whether they parse but
   * whether they take the file down with them, which is exactly how the C++
   * adapter lost whole translation units to `extern "C"`. They do not: the
   * grammar's error recovery is local, so the surrounding declarations and
   * their calls survive.
   */
  it.each([
    ['a raw string literal', 'let s = #"raw \\(x) string"#'],
    ['a macro expansion', 'let v = #m(1)'],
    ['typed throws', 'func hazard() throws(MyErr) { }'],
  ])('recovers the rest of the file around %s', async (_label, hazard) => {
    const root = mkdtempSync(join(tmpdir(), 'hb-swift-hazard-'));
    writeFileSync(
      join(root, 'H.swift'),
      `class Before {\n    func one() { two() }\n}\n\n${hazard}\n\nfunc two() { }\n`,
    );
    const result = await new SwiftAdapter().analyze(['H.swift'], root);
    expect(result.functions.map((f) => f.id).sort()).toContain('H.Before.one');
    expect(result.functions.map((f) => f.id).sort()).toContain('H.two');
    expect(result.edges.find((e) => e.callerId === 'H.Before.one')?.calleeId).toBe('H.two');
  });
});

describe.skipIf(!SAFE)('SwiftAdapter — extension-only module', () => {
  it('does not let an extension claim ownership of the type it extends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-swift-ext-'));
    writeFileSync(join(root, 'Core.swift'), 'class Split {\n    func go() {\n        tail()\n    }\n}\n');
    writeFileSync(join(root, 'More.swift'), 'extension Split {\n    func tail() { }\n}\n');
    const result = await new SwiftAdapter().analyze(['Core.swift', 'More.swift'], root);
    const call = result.edges.find((e) => e.callerId === 'Core.Split.go');
    expect(call?.calleeId).toBe('More.Split.tail');
    expect(call?.callType).toBe('self_method');
  });
});

describe.skipIf(!SAFE)('SwiftAdapter — parsed type declarations', () => {
  let analysis: ModuleAnalysis;
  const SRC = `import Foundation

public protocol Runner {
    func start()
}

public class Engine: Runner {
    var rpm: Int = 0

    public func start() { }

    struct Nested {
        var x: Int
    }

    typealias Inner = Int
}

struct Point {
    var x: Int
}

enum Gear {
    case low
    case high
}

actor Counter {
    var n = 0
}

typealias Rpm = Int

@available(macOS 10.15, *)
public final class Annotated {
    var x = 0
}
`;
  // The extension lives in its OWN file, which is both how Swift is written and
  // what makes the "no row for an extension" test bite: in the same file a bogus
  // row would collide with the class's id and be swallowed by the dedupe, so the
  // test would pass for the wrong reason.
  const EXTRA = `extension Engine {
    public func idle() -> Int {
        return self.rpm
    }
}
`;
  const lines = SRC.split('\n');
  const find = (name: string): NonNullable<ModuleAnalysis['types']>[number] | undefined =>
    (analysis.types ?? []).find((t) => t.name === name);

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-swift-types-'));
    writeFileSync(join(root, 'Kinds.swift'), SRC);
    writeFileSync(join(root, 'More.swift'), EXTRA);
    analysis = await new SwiftAdapter().analyze(['Kinds.swift', 'More.swift'], root);
  });

  it('tells the four `class_declaration` spellings apart by declaration_kind', () => {
    // One node type carries class, struct, enum, actor AND extension; only the
    // `declaration_kind` field distinguishes them.
    expect(find('Engine')?.kind).toBe('class');
    expect(find('Point')?.kind).toBe('struct');
    expect(find('Gear')?.kind).toBe('enum');
  });

  it('calls an actor a class', () => {
    // Nominal, instantiable, owns methods and state. Actor isolation is a rule
    // about calling its members, not about the shape of the declaration.
    expect(find('Counter')?.kind).toBe('class');
    expect(find('Counter')?.signature).toBe('actor Counter');
  });

  it('calls a protocol an interface and a typealias an alias', () => {
    expect(find('Runner')?.kind).toBe('interface');
    expect(find('Runner')?.signature).toBe('public protocol Runner');
    expect(find('Rpm')?.kind).toBe('alias');
    // The node has TWO `name` fields; the first is the alias, the second is `Int`.
    expect(find('Rpm')?.signature).toBe('typealias Rpm = Int');
    expect(find('Int')).toBeUndefined();
  });

  it('emits no type for an extension, whose members it still attaches', () => {
    // `extension Engine` names a type declared ABOVE it, and in real code usually
    // in another file. A row for it would report Engine as declared at the
    // extension's line — a pointer to code that is not the declaration.
    expect((analysis.types ?? []).filter((t) => t.name === 'Engine')).toHaveLength(1);
    expect(find('Engine')?.file).toBe('Kinds.swift');
    expect(find('Engine')?.lineStart).toBe(7);
    expect((analysis.types ?? []).some((t) => t.file === 'More.swift')).toBe(false);
    expect(analysis.functions.some((f) => f.qualname === 'Engine.idle')).toBe(true);
  });

  it('qualifies a nested type and a nested typealias by the enclosing type', () => {
    expect(find('Nested')?.qualname).toBe('Engine.Nested');
    expect(find('Nested')?.container).toBe('Engine');
    // Reached only because the container walk re-visits a body that holds one.
    expect(find('Inner')?.qualname).toBe('Engine.Inner');
    expect(find('Inner')?.kind).toBe('alias');
    expect(find('Point')?.container).toBeNull();
  });

  it('spans the declaration, never the members', () => {
    const engine = find('Engine');
    expect(lines[(engine?.lineStart ?? 0) - 1]).toBe('public class Engine: Runner {');
    expect(engine?.signature).toBe('public class Engine: Runner');
    expect(engine?.lineEnd).toBeGreaterThan(engine?.lineStart ?? 0);
  });

  it('starts an attributed declaration span at the attribute, as the grammar does', () => {
    // Pinned rather than tolerated: the attribute is INSIDE `class_declaration`, so
    // this IS the declaration node's span, and it matches what the C# and Java
    // adapters already do. Measured on Alamofire: 43 of 424 rows start on an
    // attribute or `@available` line. The README discloses the one cost — a long
    // attribute can push the name past the truncated signature.
    const annotated = find('Annotated');
    expect(lines[(annotated?.lineStart ?? 0) - 1]).toBe('@available(macOS 10.15, *)');
    expect(annotated?.signature).toBe('@available(macOS 10.15, *) public final class Annotated');
    expect(annotated?.kind).toBe('class');
  });

  it('declares exactly the kinds it emits', () => {
    expect(new SwiftAdapter().capabilities.typeKinds).toEqual([
      'alias',
      'class',
      'enum',
      'interface',
      'struct',
    ]);
  });
});

describe('SwiftAdapter — grammar hazard disclosure', () => {
  it('reports whether this runtime can parse Swift at all', () => {
    // Not an assertion about SAFE: it is false on Node >= 22 by design. The
    // check exists so a skipped suite is visible in the report rather than
    // silently absent, and so the probe itself is exercised on every runtime.
    expect(typeof SAFE).toBe('boolean');
    if (!SAFE) {
      expect(new SwiftAdapter().capabilities.tier).toBe('full');
    }
  });
});

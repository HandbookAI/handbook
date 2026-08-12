import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbooks/core';
import { JavaAdapter } from './java.js';

/**
 * One fixture repo laid out like a real Java tree (directory == package). Module
 * ids are path-derived, as in every adapter, so a file's module id already reads
 * as the fully qualified type name (`com.demo.app.App`) and a member id repeats
 * the type once more (`com.demo.app.App.App.run`) — the price of ids that stay
 * unique and decomposable as `<module>.<Type>.<member>`.
 */
const FILES: Record<string, string> = {
  'com/demo/app/App.java': `package com.demo.app;

import com.demo.engine.Engine;
import com.demo.util.Util;
import com.vendor.Widget;
import static com.demo.util.Util.shout;

@Service("app")
public class App extends Base implements Loader {
    private Engine engine;
    private Box<Engine> box;
    private int count;

    public App(Engine engine) {
        super();
        this.engine = engine;
    }

    @Test
    public void run() {
        this.prepare();
        this.engine.spin();
        this.box.open();
        this.shared.spin();
        this.warmUp();
        this.describe();
        Helpers.greet("hi");
        Util.trim("x");
        shout("y");
        Engine local = new Engine();
        local.spin();
        Widget w = new Widget();
        w.poke();
        Math.max(1, 2);
        this.count += 1;
        int c = this.count;
        mystery();
    }

    private void prepare() {}

    @Override
    public void reset() {
        super.reset();
    }

    @Override
    public void load() {}

    public static void boot(Engine e) {
        e.spin();
    }

    void inspect(Engine[] arr, com.demo.engine.Engine q) {
        q.spin();
    }
}
`,
  'com/demo/app/Base.java': `package com.demo.app;

import com.demo.engine.Engine;

public class Base {
    protected Engine shared;

    void warmUp() {
        this.shared.spin();
    }

    public void reset() {
        this.shared = null;
    }
}
`,
  'com/demo/app/Loader.java': `package com.demo.app;

interface Loader {
    void load();

    default String describe() {
        return "loader";
    }
}
`,
  'com/demo/app/Box.java': `package com.demo.app;

public class Box<T> {
    void open() {}

    void configure(String alphaAlphaAlpha, String bravoBravoBravo, String charlieCharlie, String deltaDeltaDelta, String echoEchoEcho, String foxtrotFoxtrot, String golfGolfGolf, String hotelHotelHotel, String indiaIndiaIndia) {}
}
`,
  'com/demo/app/Helpers.java': `package com.demo.app;

public class Helpers {
    static {
        greet("boot");
    }

    public static String greet(String text) {
        return text;
    }
}
`,
  // Unparseable on purpose: it must not take its neighbours down.
  'com/demo/app/Broken.java': `package com.demo.app;

class Broken {
    void m( {
        this.
}
`,
  'com/demo/engine/Engine.java': `package com.demo.engine;

public class Engine {
    private int rpm;

    public Engine() {
        this.rpm = 0;
    }

    public void spin() {
        this.rpm += 1;
        this.tick();
    }

    private void tick() {}
}
`,
  'com/demo/util/Util.java': `package com.demo.util;

public class Util {
    public static String shout(String text) {
        return text;
    }

    public static String trim(String s) {
        return s;
    }
}
`,
  // Build output — discovery must not see it.
  'target/classes/com/demo/app/Ghost.java': `package com.demo.app;

class Ghost {
    void haunt() {}
}
`,
  'build/generated/com/demo/app/Made.java': `package com.demo.app;

class Made {
    void made() {}
}
`,
};

function writeRepo(files: Record<string, string>, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

describe('JavaAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new JavaAdapter();

  beforeAll(async () => {
    root = writeRepo(FILES, 'hb-java-');
    analysis = await adapter.analyze(
      [
        'com/demo/app/App.java',
        'com/demo/app/Base.java',
        'com/demo/app/Loader.java',
        'com/demo/app/Box.java',
        'com/demo/app/Helpers.java',
        'com/demo/app/Broken.java',
        'com/demo/engine/Engine.java',
        'com/demo/util/Util.java',
      ],
      root,
    );
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  /** Call sites are identified by their source text, which is unique per fixture. */
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers .java files but not build output', () => {
    const files = adapter.discover(root);
    expect(files).toContain('com/demo/app/App.java');
    expect(files).toContain('com/demo/engine/Engine.java');
    expect(files).not.toContain('target/classes/com/demo/app/Ghost.java');
    expect(files).not.toContain('build/generated/com/demo/app/Made.java');
  });

  it('extracts methods, constructors and interface members', () => {
    const run = fn('com.demo.app.App.App.run');
    expect(run?.isMethod).toBe(true);
    expect(run?.className).toBe('App');
    expect(run?.isAsync).toBe(false);
    expect(fn('com.demo.app.App.App.App')?.name).toBe('App');
    expect(fn('com.demo.app.Loader.Loader.load')).toBeDefined();
    expect(fn('com.demo.app.Loader.Loader.describe')).toBeDefined();
    expect(fn('com.demo.engine.Engine.Engine.tick')).toBeDefined();
    expect(analysis.functions.every((f) => !f.isAsync)).toBe(true);
  });

  it('marks static methods as non-instance while keeping their class', () => {
    const boot = fn('com.demo.app.App.App.boot');
    expect(boot?.isMethod).toBe(false);
    expect(boot?.className).toBe('App');
  });

  it('records a static initializer so its calls are not lost', () => {
    expect(fn('com.demo.app.Helpers.Helpers.static_init')).toBeDefined();
    expect(raw('com.demo.app.Helpers.Helpers.static_init', 'greet')?.calleeId).toBe(
      'com.demo.app.Helpers.Helpers.greet',
    );
  });

  it('captures annotations as decorators', () => {
    expect(fn('com.demo.app.App.App.run')?.decorators).toEqual(['Test']);
    expect(fn('com.demo.app.App.App.reset')?.decorators).toEqual(['Override']);
    expect(fn('com.demo.app.App.App.prepare')?.decorators).toEqual([]);
  });

  it('records a single-line signature truncated to 200 chars', () => {
    const run = fn('com.demo.app.App.App.run');
    expect(run?.signature).toBe('@Test public void run()');
    const long = fn('com.demo.app.Box.Box.configure');
    expect(long?.signature).toHaveLength(200);
    expect(long?.signature).not.toContain('\n');
  });

  it('resolves this.m() and bare m() in the enclosing class to self_method', () => {
    const e = raw('com.demo.app.App.App.run', 'this.prepare');
    expect(e?.callType).toBe('self_method');
    expect(e?.calleeId).toBe('com.demo.app.App.App.prepare');
  });

  it('resolves this.field.m() through a learned field type', () => {
    const e = raw('com.demo.app.App.App.run', 'this.engine.spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.calleeId).toBe('com.demo.engine.Engine.Engine.spin');
  });

  it('peels generics off field types', () => {
    const e = raw('com.demo.app.App.App.run', 'this.box.open');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.calleeId).toBe('com.demo.app.Box.Box.open');
  });

  it('peels arrays and qualified names off parameter types', () => {
    expect(fn('com.demo.app.App.App.inspect')?.paramTypes).toEqual({ arr: 'Engine', q: 'Engine' });
    const e = raw('com.demo.app.App.App.inspect', 'q.spin');
    expect(e?.callType).toBe('param_method');
    expect(e?.calleeId).toBe('com.demo.engine.Engine.Engine.spin');
  });

  it('resolves param.m() through a declared parameter type', () => {
    const e = raw('com.demo.app.App.App.boot', 'e.spin');
    expect(e?.callType).toBe('param_method');
    expect(e?.calleeId).toBe('com.demo.engine.Engine.Engine.spin');
  });

  it('resolves a typed local variable', () => {
    const e = raw('com.demo.app.App.App.run', 'local.spin');
    expect(e?.callType).toBe('param_method');
    expect(e?.calleeId).toBe('com.demo.engine.Engine.Engine.spin');
  });

  it('resolves a same-package sibling static call without an import', () => {
    const e = raw('com.demo.app.App.App.run', 'Helpers.greet');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('com.demo.app.Helpers.Helpers.greet');
  });

  it('resolves a static call on an imported scanned class', () => {
    const e = raw('com.demo.app.App.App.run', 'Util.trim');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('com.demo.util.Util.Util.trim');
  });

  it('resolves a bare call reached through a static import', () => {
    const e = raw('com.demo.app.App.App.run', 'shout');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('com.demo.util.Util.Util.shout');
  });

  it('resolves new on a scanned class to internal_constructor', () => {
    const e = raw('com.demo.app.App.App.run', 'new Engine()');
    expect(e?.callType).toBe('internal_constructor');
    expect(e?.calleeId).toBe('com.demo.engine.Engine.Engine.Engine');
  });

  it('sends new on an unscanned class to boundary_constructor with its import path', () => {
    const e = raw('com.demo.app.App.App.run', 'new Widget()');
    expect(e?.callType).toBe('boundary_constructor');
    expect(e?.calleeId).toBe('boundary:com.vendor.Widget');
  });

  it('sends calls on a known-unscanned type to boundary', () => {
    expect(raw('com.demo.app.App.App.run', 'w.poke')?.calleeId).toBe('boundary:com.vendor.Widget.poke');
    expect(raw('com.demo.app.App.App.run', 'w.poke')?.callType).toBe('boundary');
  });

  it('treats an unimported capitalized qualifier as a boundary type (java.lang)', () => {
    const e = raw('com.demo.app.App.App.run', 'Math.max');
    expect(e?.callType).toBe('boundary');
    expect(e?.calleeId).toBe('boundary:Math.max');
  });

  it('resolves an inherited method to the ancestor that declares it', () => {
    expect(raw('com.demo.app.App.App.run', 'this.warmUp')?.calleeId).toBe('com.demo.app.Base.Base.warmUp');
    expect(raw('com.demo.app.App.App.run', 'this.warmUp')?.callType).toBe('self_method');
  });

  it('resolves a default method inherited from a scanned interface', () => {
    const e = raw('com.demo.app.App.App.run', 'this.describe');
    expect(e?.callType).toBe('self_method');
    expect(e?.calleeId).toBe('com.demo.app.Loader.Loader.describe');
  });

  it('resolves super.m() to the superclass method', () => {
    const e = raw('com.demo.app.App.App.reset', 'super.reset');
    expect(e?.callType).toBe('self_method');
    expect(e?.calleeId).toBe('com.demo.app.Base.Base.reset');
  });

  it('resolves an inherited field type for this.field.m()', () => {
    const e = raw('com.demo.app.App.App.run', 'this.shared.spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.calleeId).toBe('com.demo.engine.Engine.Engine.spin');
  });

  it('resolves super(...) to the superclass constructor', () => {
    const e = raw('com.demo.app.App.App.App', 'super()');
    expect(e?.callType).toBe('internal_constructor');
    expect(e?.calleeId).toBe('com.demo.app.Base.Base.Base');
  });

  it('tracks this.field reads and writes', () => {
    expect(fn('com.demo.app.App.App.App')?.selfAttrsWritten).toContain('engine');
    const run = fn('com.demo.app.App.App.run');
    expect(run?.selfAttrsWritten).toContain('count');
    expect(run?.selfAttrsRead).toContain('count');
    expect(fn('com.demo.app.Base.Base.reset')?.selfAttrsWritten).toEqual(['shared']);
    expect(fn('com.demo.app.Base.Base.warmUp')?.selfAttrsRead).toEqual(['shared']);
    const spin = fn('com.demo.engine.Engine.Engine.spin');
    expect(spin?.selfAttrsWritten).toEqual(['rpm']);
    expect(spin?.selfAttrsRead).toEqual(['rpm']);
  });

  it('leaves an ungroundable call unresolved', () => {
    const e = raw('com.demo.app.App.App.run', 'mystery');
    expect(e?.callType).toBe('unresolved');
    expect(e?.calleeId).toBe('unresolved:mystery');
  });

  it('skips a file that fails to parse without losing its neighbours', () => {
    expect(analysis.functions.filter((f) => f.file === 'com/demo/app/Broken.java')).toEqual([]);
    expect(fn('com.demo.app.Helpers.Helpers.greet')).toBeDefined();
    expect(fn('com.demo.engine.Engine.Engine.spin')).toBeDefined();
  });
});

describe('JavaAdapter — overloads share one id', () => {
  it('collapses overloads to one node without multiplying edges, and resolves this(...)', async () => {
    const root = writeRepo(
      {
        'a/T.java': `package a;

class T {
    T(int x) { helper(); }
    T() { this(1); }
    void m() { helper(); }
    void m(int x) { helper(); helper(); }
    void helper() {}
}
`,
      },
      'hb-java-overload-',
    );
    const result = await new JavaAdapter().analyze(['a/T.java'], root);
    // Java overloads share `<module>.<Type>.<name>`; the spine's dedupe keeps the
    // LAST definition, so one logical id must not multiply its edges — the edges
    // below are those of `m(int)` and of the no-arg constructor.
    expect(result.functions.filter((f) => f.id === 'a.T.T.m')).toHaveLength(1);
    expect(result.functions.filter((f) => f.id === 'a.T.T.T')).toHaveLength(1);
    expect(result.edges.filter((e) => e.callerId === 'a.T.T.m')).toHaveLength(2);
    const self = result.edges.find((e) => e.raw === 'this(1)');
    expect(self?.callType).toBe('internal_constructor');
    expect(self?.calleeId).toBe('a.T.T.T');
  });
});

describe('JavaAdapter — the other places a type is declared', () => {
  let result: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(
      {
        'wild/Runner.java': `package wild;

import demo.*;

class Runner {
    void go(Engine... engines) {
        var made = new Engine();
        made.spin();
        for (Engine each : list()) {
            each.spin();
        }
        try (Engine open = grab()) {
            open.spin();
        } catch (Trouble t) {
            t.report();
        }
        Runnable r = new Runnable() {
            public void run() {
                hidden();
            }
        };
    }

    Engine[] list() {
        return null;
    }

    Engine grab() {
        return null;
    }
}
`,
        'demo/Engine.java': `package demo;

public class Engine {
    public void spin() {}
}
`,
        'demo/Trouble.java': `package demo;

public class Trouble extends RuntimeException {
    public void report() {}
}
`,
      },
      'hb-java-wild-',
    );
    result = await new JavaAdapter().analyze(
      ['wild/Runner.java', 'demo/Engine.java', 'demo/Trouble.java'],
      root,
    );
  });

  const edge = (text: string) => result.edges.find((e) => e.raw === text);

  it('records a varargs parameter at its element type', () => {
    expect(result.functions.find((f) => f.id === 'wild.Runner.Runner.go')?.paramTypes).toEqual({
      engines: 'Engine',
    });
  });

  it('resolves types made visible by an on-demand import', () => {
    expect(edge('made.spin')?.calleeId).toBe('demo.Engine.Engine.spin');
    expect(edge('made.spin')?.callType).toBe('param_method');
  });

  it('infers the type var hides from its constructor initializer', () => {
    // `var made = new Engine()` is the only declaration of `made`.
    expect(edge('made.spin')).toBeDefined();
  });

  it('learns for-each, try-with-resources and catch variables', () => {
    expect(edge('each.spin')?.calleeId).toBe('demo.Engine.Engine.spin');
    expect(edge('open.spin')?.calleeId).toBe('demo.Engine.Engine.spin');
    expect(edge('t.report')?.calleeId).toBe('demo.Trouble.Trouble.report');
  });

  it('skips an anonymous class body, whose this is a different object', () => {
    expect(edge('hidden')).toBeUndefined();
    expect(edge('new Runnable() { public void run() { hidden(); } }')?.callType).toBe('boundary_constructor');
  });
});

describe('JavaAdapter — records, enums and nested types', () => {
  let result: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(
      {
        'shape/Shapes.java': `package shape;

record Point(int x, Engine engine) {
    Point {
        engine.spin();
    }

    void show() {
        this.engine.spin();
    }
}

enum Mode {
    FAST, SLOW;

    void apply() {
        helper();
    }

    static void helper() {}
}

class Outer {
    static class Inner {
        static void deep() {}
    }

    void use() {
        Outer.Inner.deep();
        Inner.deep();
    }
}
`,
        'shape/Engine.java': `package shape;

class Engine {
    void spin() {}
}
`,
      },
      'hb-java-shapes-',
    );
    result = await new JavaAdapter().analyze(['shape/Shapes.java', 'shape/Engine.java'], root);
  });

  const edge = (caller: string, text: string) =>
    result.edges.find((e) => e.callerId === caller && e.raw === text);

  it('learns record components as field types, compact constructor included', () => {
    expect(result.functions.find((f) => f.id === 'shape.Shapes.Point.Point')).toBeDefined();
    expect(edge('shape.Shapes.Point.Point', 'engine.spin')?.calleeId).toBe('shape.Engine.Engine.spin');
    const show = edge('shape.Shapes.Point.show', 'this.engine.spin');
    expect(show?.callType).toBe('self_attr_method');
    expect(show?.calleeId).toBe('shape.Engine.Engine.spin');
  });

  it('scans enum bodies', () => {
    expect(edge('shape.Shapes.Mode.apply', 'helper')?.calleeId).toBe('shape.Shapes.Mode.helper');
  });

  it('scans nested types and resolves both qualified and simple references', () => {
    expect(result.functions.find((f) => f.id === 'shape.Shapes.Inner.deep')).toBeDefined();
    expect(edge('shape.Shapes.Outer.use', 'Outer.Inner.deep')?.calleeId).toBe('shape.Shapes.Inner.deep');
    expect(edge('shape.Shapes.Outer.use', 'Inner.deep')?.callType).toBe('internal_func');
  });
});

describe('JavaAdapter — capability declaration', () => {
  it('declares full fidelity with self-attribute tracking and no statement spans', () => {
    const adapter = new JavaAdapter();
    expect(adapter.capabilities.tier).toBe('full');
    expect(adapter.capabilities.selfAttrs).toBe(true);
    expect(adapter.capabilities.statementSpans).toBe(false);
    expect(adapter.statementSpans).toBeUndefined();
  });
});

/**
 * Java's five type declarations, including the two the grammar's node names would
 * mis-bucket.
 */
describe('JavaAdapter — parsed type declarations', () => {
  let analysis: ModuleAnalysis;
  const SRC = `package engine;

public class Outer {
    void go() {}

    static class Inner {
        void deep() {}
    }
}

interface Spinner {
    void spin();
}

enum Gear {
    LOW,
    HIGH
}

record Rpm(int value) {}

@interface Nullable {}
`;
  const lines = SRC.split('\n');
  const find = (name: string): NonNullable<ModuleAnalysis['types']>[number] | undefined =>
    (analysis.types ?? []).find((t) => t.name === name);

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-java-types-'));
    mkdirSync(join(root, 'engine'), { recursive: true });
    writeFileSync(join(root, 'engine', 'Kinds.java'), SRC);
    analysis = await new JavaAdapter().analyze(['engine/Kinds.java'], root);
  });

  it('maps class, interface and enum onto the obvious buckets', () => {
    expect(find('Outer')?.kind).toBe('class');
    expect(find('Spinner')?.kind).toBe('interface');
    expect(find('Gear')?.kind).toBe('enum');
  });

  it('calls a record a record, not a struct', () => {
    // A Java record is a REFERENCE type, so `struct` would be wrong in the one
    // vocabulary where `struct` also means "value type" for Go, Rust and C#.
    expect(find('Rpm')?.kind).toBe('record');
    expect(find('Rpm')?.signature).toContain('record Rpm(int value)');
  });

  it('calls an @interface `other`, not an interface', () => {
    // `@interface` is spelled like one and is nothing like one: not implementable,
    // never a supertype, never in an `implements` clause. The signature still says
    // what it is, so the escape hatch loses no information.
    expect(find('Nullable')?.kind).toBe('other');
    expect(find('Nullable')?.signature).toContain('@interface Nullable');
  });

  it('qualifies a nested type by its enclosing type', () => {
    // `Inner` alone would collide with any other `Inner` in the module; call
    // resolution still keys on the simple name, which is how Java source refers to
    // a nested type from inside its enclosing one.
    const inner = find('Inner');
    expect(inner?.qualname).toBe('Outer.Inner');
    expect(inner?.container).toBe('Outer');
    expect(lines[(inner?.lineStart ?? 0) - 1]).toContain('static class Inner');
    // Nested inside the outer span, not beside it.
    expect(inner?.lineStart).toBeGreaterThan(find('Outer')?.lineStart ?? 0);
    expect(inner?.lineEnd).toBeLessThan(find('Outer')?.lineEnd ?? 0);
  });
});

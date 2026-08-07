import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
import { CSharpAdapter } from './csharp.js';

/** Types the App file leans on. Same namespace AND same directory as App.cs. */
const MOTOR_CS = `namespace Demo.Engines;

public interface IRunner
{
    void Start();

    void Ping() { }
}

public class EngineBase
{
    protected int cycles;

    public virtual void Warmup()
    {
        this.cycles = 0;
    }

    public void Reset()
    {
        this.cycles = 0;
    }
}

public class Engine : EngineBase
{
    public int Rpm { get; set; }

    public Engine()
    {
        this.Rpm = 0;
    }

    public void Spin()
    {
        this.Rpm = this.Rpm + 1;
    }

    public async Task<int> SpinAsync()
    {
        return this.Rpm;
    }

    public static Engine Fresh()
    {
        return new Engine();
    }
}
`;

/**
 * Note what is deliberately ABSENT: no \`using\` naming Demo.Engines, because
 * App.cs already lives in it — C# resolves same-namespace types without one.
 */
const APP_CS = `using System;
using Demo.Tools;
using static Demo.Tools.Helpers;
using Txt = Demo.Tools.Helpers;
using Snd = Demo.Audio.Speaker;

namespace Demo.Engines
{
    public class App : EngineBase, IRunner
    {
        private Engine engine;
        private int hits;
        public Radio? Radio { get; set; }
        public List<Engine> Engines = new List<Engine>();

        public App(Engine engine)
        {
            this.engine = engine;
            this.hits = 0;
        }

        [Obsolete("legacy")]
        public async Task<int> Run(Engine other, string label)
        {
            this.Prepare();
            this.engine.Spin();
            this.Radio.Play();
            this.Engines.Add(other);
            other.Spin();
            Engine typed = new Engine();
            typed.Spin();
            var inferred = new Engine();
            inferred.Spin();
            Helpers.Shout(label);
            Shout(label);
            Txt.Shout(label);
            Snd.Beep();
            Engine.Fresh();
            this.Reset();
            this.Ping();
            this.Warmup();
            var widget = new Widget();
            Console.WriteLine(label);
            mystery.Poke();
            this.hits += 1;
            return await this.engine.SpinAsync();
        }

        public void Start()
        {
            hits = 2;
        }

        public override void Warmup()
        {
            base.Warmup();
        }

        private void Prepare()
        {
            int Bump(int n) { return n + 1; }
            Bump(this.hits);
        }

        public int Hits
        {
            get { return this.hits; }
            set { this.hits = value; }
        }

        [Fact]
        [Trait("k", "v")]
        public void Load(Engine[] pool)
        {
        }
    }
}
`;

const TEXT_CS = `namespace Demo.Tools;

public static class Helpers
{
    private static int calls;

    public static string Shout(string text)
    {
        calls = calls + 1;
        return text.ToUpper();
    }
}
`;

/** Not C# at all: must be skipped without taking its neighbours down. */
const BROKEN_CS = `%%% not C# {{{ ??? ]]]
class }}} <<< &&&
++ ++ ++
`;

const FILES: Record<string, string> = {
  'src/Motor.cs': MOTOR_CS,
  'src/App.cs': APP_CS,
  'src/Broken.cs': BROKEN_CS,
  'tools/Text.cs': TEXT_CS,
  'bin/Ignored.cs': 'class Ignored { }\n',
  'obj/Debug/Gen.cs': 'class Gen { }\n',
  'src/Form.Designer.cs': 'class Form { }\n',
  'src/Xaml.g.cs': 'class Xaml { }\n',
  'src/Proto.generated.cs': 'class Proto { }\n',
};

describe('CSharpAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new CSharpAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-cs-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    analysis = await adapter.analyze(
      ['src/Motor.cs', 'src/App.cs', 'src/Broken.cs', 'tools/Text.cs'],
      root,
    );
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers .cs files, skipping bin/obj and generated files', () => {
    const files = adapter.discover(root);
    expect(files).toContain('src/App.cs');
    expect(files).toContain('tools/Text.cs');
    expect(files).not.toContain('bin/Ignored.cs');
    expect(files).not.toContain('obj/Debug/Gen.cs');
    expect(files).not.toContain('src/Form.Designer.cs');
    expect(files).not.toContain('src/Xaml.g.cs');
    expect(files).not.toContain('src/Proto.generated.cs');
  });

  it('derives module ids from the path, not the namespace', () => {
    expect(fn('src.App.App.Run')).toBeDefined();
    expect(fn('src.Motor.Engine.Spin')).toBeDefined();
    expect(fn('tools.Text.Helpers.Shout')).toBeDefined();
  });

  it('extracts methods, constructors and static methods', () => {
    const run = fn('src.App.App.Run');
    expect(run?.isMethod).toBe(true);
    expect(run?.className).toBe('App');
    expect(fn('src.App.App.App')?.className).toBe('App');
    const shout = fn('tools.Text.Helpers.Shout');
    expect(shout?.className).toBe('Helpers');
    expect(fn('src.Motor.Engine.Fresh')).toBeDefined();
  });

  it('records bodiless interface/abstract declarations so edges never dangle', () => {
    expect(fn('src.Motor.IRunner.Start')).toBeDefined();
    expect(fn('src.Motor.IRunner.Ping')).toBeDefined();
  });

  it('turns property accessors with bodies into functions, auto-properties not', () => {
    expect(fn('src.App.App.get_Hits')).toBeDefined();
    expect(fn('src.App.App.set_Hits')).toBeDefined();
    expect(fn('src.Motor.Engine.get_Rpm')).toBeUndefined();
  });

  it('records local functions under their enclosing member', () => {
    const bump = fn('src.App.App.Prepare.Bump');
    expect(bump?.className).toBe('App');
    expect(bump?.isMethod).toBe(false);
  });

  it('detects the async modifier', () => {
    expect(fn('src.App.App.Run')?.isAsync).toBe(true);
    expect(fn('src.Motor.Engine.SpinAsync')?.isAsync).toBe(true);
    expect(fn('src.App.App.Prepare')?.isAsync).toBe(false);
  });

  it('captures attributes as decorators', () => {
    expect(fn('src.App.App.Run')?.decorators).toEqual(['Obsolete']);
    expect(fn('src.App.App.Load')?.decorators).toEqual(['Fact', 'Trait']);
    expect(fn('src.App.App.Prepare')?.decorators).toEqual([]);
  });

  it('gives a single-line signature without the attribute prefix', () => {
    const sig = fn('src.App.App.Run')?.signature ?? '';
    expect(sig).toBe('public async Task<int> Run(Engine other, string label)');
    expect(sig.length).toBeLessThanOrEqual(200);
  });

  it('learns parameter types, peeling arrays down to the element type', () => {
    expect(fn('src.App.App.Run')?.paramTypes).toEqual({ other: 'Engine' });
    expect(fn('src.App.App.Load')?.paramTypes).toEqual({ pool: 'Engine' });
  });

  it('tracks this-attribute reads and writes', () => {
    const run = fn('src.App.App.Run');
    expect(run?.selfAttrsWritten).toContain('hits');
    expect(run?.selfAttrsRead).toContain('hits');
    expect(run?.selfAttrsRead).toContain('engine');
    expect(fn('src.App.App.App')?.selfAttrsWritten).toEqual(['engine', 'hits']);
    const spin = fn('src.Motor.Engine.Spin');
    expect(spin?.selfAttrsWritten).toContain('Rpm');
    expect(spin?.selfAttrsRead).toContain('Rpm');
  });

  it('tracks bare field access written without this.', () => {
    expect(fn('src.App.App.Start')?.selfAttrsWritten).toEqual(['hits']);
    const shout = fn('tools.Text.Helpers.Shout');
    expect(shout?.selfAttrsWritten).toEqual(['calls']);
    expect(shout?.selfAttrsRead).toEqual(['calls']);
  });

  it('does not mistake an invoked method name for a state attribute', () => {
    expect(fn('src.App.App.Run')?.selfAttrsRead).not.toContain('Prepare');
  });

  it('resolves this.M() in the same file to self_method', () => {
    expect(edge('src.App.App.Run', 'src.App.App.Prepare')?.callType).toBe('self_method');
  });

  it('resolves an inherited method through the scanned base class', () => {
    expect(edge('src.App.App.Run', 'src.Motor.EngineBase.Reset')?.callType).toBe('self_method');
  });

  it('resolves an inherited default interface method', () => {
    expect(edge('src.App.App.Run', 'src.Motor.IRunner.Ping')?.callType).toBe('self_method');
  });

  it('prefers the override for this.M() and the base for base.M()', () => {
    expect(edge('src.App.App.Run', 'src.App.App.Warmup')?.callType).toBe('self_method');
    expect(edge('src.App.App.Warmup', 'src.Motor.EngineBase.Warmup')?.callType).toBe('self_method');
  });

  it('resolves this.field.M() through the learned field type', () => {
    const e = raw('src.App.App.Run', 'this.engine.Spin');
    expect(e?.calleeId).toBe('src.Motor.Engine.Spin');
    expect(e?.callType).toBe('self_attr_method');
  });

  it('peels a nullable property type and sends unscanned types to boundary', () => {
    expect(edge('src.App.App.Run', 'boundary:Radio.Play')?.callType).toBe('boundary');
  });

  it('peels a generic field type down to its container', () => {
    expect(edge('src.App.App.Run', 'boundary:List.Add')?.callType).toBe('boundary');
  });

  it('resolves param.M() through the declared parameter type', () => {
    const e = raw('src.App.App.Run', 'other.Spin');
    expect(e?.calleeId).toBe('src.Motor.Engine.Spin');
    expect(e?.callType).toBe('param_method');
  });

  it('resolves an explicitly typed local', () => {
    expect(raw('src.App.App.Run', 'typed.Spin')?.callType).toBe('param_method');
    expect(raw('src.App.App.Run', 'typed.Spin')?.calleeId).toBe('src.Motor.Engine.Spin');
  });

  it('resolves a var local through its new-expression initializer', () => {
    expect(raw('src.App.App.Run', 'inferred.Spin')?.callType).toBe('param_method');
    expect(raw('src.App.App.Run', 'inferred.Spin')?.calleeId).toBe('src.Motor.Engine.Spin');
  });

  it('resolves a static call on a scanned type to internal_func', () => {
    expect(edge('src.App.App.Run', 'tools.Text.Helpers.Shout')?.callType).toBe('internal_func');
    expect(raw('src.App.App.Run', 'Engine.Fresh')?.calleeId).toBe('src.Motor.Engine.Fresh');
    expect(raw('src.App.App.Run', 'Engine.Fresh')?.callType).toBe('internal_func');
  });

  it('resolves a bare call made visible by using static', () => {
    expect(raw('src.App.App.Run', 'Shout')?.calleeId).toBe('tools.Text.Helpers.Shout');
    expect(raw('src.App.App.Run', 'Shout')?.callType).toBe('internal_func');
  });

  it('resolves a using-alias to a scanned type, and to boundary when unscanned', () => {
    expect(raw('src.App.App.Run', 'Txt.Shout')?.calleeId).toBe('tools.Text.Helpers.Shout');
    expect(edge('src.App.App.Run', 'boundary:Demo.Audio.Speaker.Beep')?.callType).toBe('boundary');
  });

  it('resolves a local function call to its own node', () => {
    const e = edge('src.App.App.Prepare', 'src.App.App.Prepare.Bump');
    expect(e?.callType).toBe('internal_func');
  });

  it('separates scanned from unscanned new-expressions', () => {
    expect(raw('src.App.App.Run', 'new Engine()')?.calleeId).toBe('src.Motor.Engine.Engine');
    expect(raw('src.App.App.Run', 'new Engine()')?.callType).toBe('internal_constructor');
    expect(edge('src.App.App.Run', 'boundary:Widget')?.callType).toBe('boundary_constructor');
  });

  it('sends an unscanned qualified receiver to boundary', () => {
    expect(edge('src.App.App.Run', 'boundary:Console.WriteLine')?.callType).toBe('boundary');
  });

  it('leaves an ungroundable receiver unresolved', () => {
    expect(raw('src.App.App.Run', 'mystery.Poke')?.callType).toBe('unresolved');
    expect(raw('tools.Text.Helpers.Shout', 'text.ToUpper')?.callType).toBe('unresolved');
  });

  it('flags awaited calls', () => {
    expect(raw('src.App.App.Run', 'this.engine.SpinAsync')?.isAwait).toBe(true);
    expect(raw('src.App.App.Run', 'other.Spin')?.isAwait).toBe(false);
  });

  it('skips an unparseable file without taking its neighbours down', () => {
    expect(analysis.functions.some((f) => f.file === 'src/Broken.cs')).toBe(false);
    expect(analysis.functions.some((f) => f.file === 'src/App.cs')).toBe(true);
    expect(analysis.functions.some((f) => f.file === 'tools/Text.cs')).toBe(true);
  });
});

describe('CSharpAdapter — partial types split across files', () => {
  it('resolves this.M() to the half of the type declared in the other file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-cs-partial-'));
    writeFileSync(
      join(root, 'Front.cs'),
      'namespace Demo;\n\npublic partial class Split\n{\n    public void Go()\n    {\n        this.Tail();\n    }\n}\n',
    );
    writeFileSync(
      join(root, 'Back.cs'),
      'namespace Demo;\n\npublic partial class Split\n{\n    public void Tail() { }\n}\n',
    );
    const result = await new CSharpAdapter().analyze(['Front.cs', 'Back.cs'], root);
    const call = result.edges.find((e) => e.callerId === 'Front.Split.Go');
    expect(call?.calleeId).toBe('Back.Split.Tail');
    expect(call?.callType).toBe('self_method');
  });
});

describe('CSharpAdapter — duplicate-id defense', () => {
  it('collapses duplicate member defs (invalid source) without multiplying edges', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-cs-dup-'));
    // Two identical methods in one class is invalid C#, but a partial or broken
    // source must still yield unique ids and un-multiplied edges.
    writeFileSync(
      join(root, 'A.cs'),
      'class T {\n  void M() { H(); }\n  void M() { H(); H(); }\n  void H() { }\n}\n',
    );
    const result = await new CSharpAdapter().analyze(['A.cs'], root);
    expect(result.functions.filter((f) => f.id === 'A.T.M')).toHaveLength(1);
    expect(result.edges.filter((e) => e.callerId === 'A.T.M')).toHaveLength(2);
  });
});

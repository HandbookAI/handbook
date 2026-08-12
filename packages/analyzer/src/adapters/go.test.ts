import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbooks/core';
import { GoAdapter } from './go.js';

const CAR_GO = `
package main

import (
	"fmt"
	str "strings"
)

type Car struct {
	Engine *Engine
	Radio  *Radio
	name   string
}

func (c *Car) Drive(other *Engine) {
	c.Start()
	c.Engine.Spin()
	c.Radio.Play()
	other.Spin()
	fmt.Println("driving")
	str.ToUpper("x")
	helper()
	c.name = "moving"
	mystery()
	c.Missing()
}

func (c *Car) Start() {}

func helper() {}
`;

const ENGINE_GO = `
package main

type Engine struct {
	rpm int
}

func (e *Engine) Spin() {
	e.rpm = e.rpm + 1
}
`;

describe('GoAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new GoAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-go-'));
    writeFileSync(join(root, 'car.go'), CAR_GO);
    writeFileSync(join(root, 'engine.go'), ENGINE_GO);
    writeFileSync(join(root, 'car_test.go'), 'package main\n\nfunc TestNothing() {}\n');
    analysis = await adapter.analyze(['car.go', 'engine.go'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('discovers .go files but skips _test.go', () => {
    const files = adapter.discover(root);
    expect(files).toContain('car.go');
    expect(files).not.toContain('car_test.go');
  });

  it('extracts free functions and receiver methods', () => {
    const drive = fn('car.Car.Drive');
    expect(drive?.isMethod).toBe(true);
    expect(drive?.className).toBe('Car');
    expect(drive?.isAsync).toBe(false);
    expect(fn('car.helper')?.isMethod).toBe(false);
    expect(fn('engine.Engine.Spin')).toBeDefined();
  });

  it('tracks receiver attribute reads and writes', () => {
    expect(fn('car.Car.Drive')?.selfAttrsWritten).toContain('name');
    const spin = fn('engine.Engine.Spin');
    expect(spin?.selfAttrsWritten).toContain('rpm');
    expect(spin?.selfAttrsRead).toContain('rpm');
  });

  it('resolves r.M() on the receiver to self_method', () => {
    expect(edge('car.Car.Drive', 'car.Car.Start')?.callType).toBe('self_method');
  });

  it('resolves r.field.M() through learned struct field types', () => {
    const e = edge('car.Car.Drive', 'engine.Engine.Spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.isAwait).toBe(false);
  });

  it('sends known-unscanned field types to boundary', () => {
    expect(edge('car.Car.Drive', 'boundary:Radio.Play')?.callType).toBe('boundary');
  });

  it('resolves param.M() through typed parameters', () => {
    const e = analysis.edges.find((x) => x.callerId === 'car.Car.Drive' && x.raw === 'other.Spin');
    expect(e?.callType).toBe('param_method');
    expect(e?.calleeId).toBe('engine.Engine.Spin');
  });

  it('routes imported packages (incl. aliases) to boundary', () => {
    expect(edge('car.Car.Drive', 'boundary:fmt.Println')?.callType).toBe('boundary');
    expect(edge('car.Car.Drive', 'boundary:strings.ToUpper')?.callType).toBe('boundary');
  });

  it('resolves local free functions and leaves unknowns unresolved', () => {
    expect(edge('car.Car.Drive', 'car.helper')?.callType).toBe('internal_func');
    const mystery = analysis.edges.find((e) => e.raw === 'mystery');
    expect(mystery?.callType).toBe('unresolved');
    const missing = analysis.edges.find((e) => e.raw === 'c.Missing');
    expect(missing?.callType).toBe('unresolved');
  });
});

describe('GoAdapter — cross-package calls through imports', () => {
  let analysis: ModuleAnalysis;
  const adapter = new GoAdapter();

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-go-xpkg-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'util'), { recursive: true });
    mkdirSync(join(root, 'internal', 'util'), { recursive: true });
    writeFileSync(
      join(root, 'main.go'),
      'package main\n\nimport (\n\t"fmt"\n\t"example.com/demo/util"\n\tiu "example.com/demo/internal/util"\n)\n\nfunc doIt() {\n\tutil.Upper("x")\n\tiu.Trim("y")\n\tfmt.Println("hi")\n}\n',
    );
    writeFileSync(
      join(root, 'util', 'strings.go'),
      'package util\n\nfunc Upper(s string) string { return s }\n',
    );
    writeFileSync(
      join(root, 'internal', 'util', 'trim.go'),
      'package util\n\nfunc Trim(s string) string { return s }\n',
    );
    analysis = await adapter.analyze(['main.go', 'util/strings.go', 'internal/util/trim.go'], root);
  });

  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('resolves pkg.F() to a scanned package matched by import-path suffix', () => {
    const e = edge('main.doIt', 'util.strings.Upper');
    expect(e?.callType).toBe('internal_func');
  });

  it('prefers the longest scanned-directory match for nested packages', () => {
    const e = edge('main.doIt', 'internal.util.trim.Trim');
    expect(e?.callType).toBe('internal_func');
  });

  it('keeps stdlib and unscanned imports at boundary', () => {
    expect(edge('main.doIt', 'boundary:fmt.Println')?.callType).toBe('boundary');
  });
});

describe('GoAdapter — sibling-file package calls (round-1 review)', () => {
  it('resolves a bare call to a free function defined in another file of the same package', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'hb-go-sibling-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'a.go'), 'package app\n\nfunc Caller() {\n\tHelper()\n}\n');
    writeFileSync(join(root, 'app', 'b.go'), 'package app\n\nfunc Helper() {}\n');
    const adapter = new GoAdapter();
    const result = await adapter.analyze(['app/a.go', 'app/b.go'], root);
    const edge = result.edges.find((e) => e.callerId === 'app.a.Caller');
    expect(edge?.calleeId).toBe('app.b.Helper');
    expect(edge?.callType).toBe('internal_func');
  });
});

describe('GoAdapter — duplicate-id defense (adversarial round)', () => {
  it('collapses duplicate method defs (invalid source) to one node without multiplying edges', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'hb-go-dup-'));
    // Two `func (t *T) M()` in one file is invalid Go, but partial/broken
    // sources must still yield unique ids and un-multiplied edges.
    const src =
      'package main\ntype T struct{}\nfunc (t *T) M() { helper() }\nfunc (t *T) M() { helper(); helper() }\nfunc helper() {}\n';
    writeFileSync(join(root, 'a.go'), src);
    const result = await new GoAdapter().analyze(['a.go'], root);
    expect(result.functions.filter((n) => n.id === 'a.T.M')).toHaveLength(1);
    expect(result.edges.filter((e) => e.callerId === 'a.T.M')).toHaveLength(2);
  });
});

/**
 * Go's four flavours of `type`, and the one that must NOT be called an alias.
 */
describe('GoAdapter — parsed type declarations', () => {
  let analysis: ModuleAnalysis;
  const SRC = `package m

type Engine struct {
	Name string
}

type Runner interface {
	Run() error
}

type Celsius float64

type Alias = Engine

type (
	A struct{ x int }
	B interface{ Go() }
)
`;
  const lines = SRC.split('\n');
  const kind = (name: string): string | undefined =>
    (analysis.types ?? []).find((t) => t.name === name)?.kind;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-go-types-'));
    writeFileSync(join(root, 'm.go'), SRC);
    analysis = await new GoAdapter().analyze(['m.go'], root);
  });

  it('separates struct from interface from alias', () => {
    expect(kind('Engine')).toBe('struct');
    expect(kind('Runner')).toBe('interface');
    expect(kind('Alias')).toBe('alias');
  });

  it('calls a DEFINED type `other`, never `alias`', () => {
    // `type Celsius float64` creates a distinct type with its own method set;
    // `type Alias = Engine` creates a second name for one. Filing the first as an
    // alias would state the opposite of Go's own rule, so it gets the escape
    // hatch plus a signature showing exactly what was written.
    expect(kind('Celsius')).toBe('other');
    expect((analysis.types ?? []).find((t) => t.name === 'Celsius')?.signature).toBe('type Celsius float64');
  });

  it('gives each member of a grouped declaration its own span', () => {
    // One span covering the whole `type ( … )` block would point A and B at the
    // same lines, which is a wrong pointer for at least one of them.
    const a = (analysis.types ?? []).find((t) => t.name === 'A');
    const b = (analysis.types ?? []).find((t) => t.name === 'B');
    expect(a?.lineStart).not.toBe(b?.lineStart);
    expect(lines[(a?.lineStart ?? 0) - 1]).toContain('A struct');
    expect(lines[(b?.lineStart ?? 0) - 1]).toContain('B interface');
  });

  it('keeps the `type` keyword in a single declaration and stops before the fields', () => {
    expect((analysis.types ?? []).find((t) => t.name === 'Engine')?.signature).toBe('type Engine struct');
    const engine = (analysis.types ?? []).find((t) => t.name === 'Engine');
    expect(lines[(engine?.lineStart ?? 0) - 1]).toContain('type Engine struct');
    expect(engine?.lineEnd).toBeGreaterThan(engine?.lineStart ?? 0);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
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

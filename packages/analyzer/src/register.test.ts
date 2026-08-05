/**
 * Capability-consistency guard.
 *
 * Two fidelity tiers coexist in one graph and nothing downstream can tell them
 * apart from nodes and edges alone, so each adapter DECLARES what it can do.
 * A declaration nobody checks drifts from the implementation — this repo has
 * been burned by shape drift more than once — so every registered adapter is run
 * against a fixture repo here and its declaration is compared to what it
 * actually emitted, in both directions.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbook/core';
import { availableLanguages, getAdapter, type LanguageAdapter } from './adapter.js';
import { registerBuiltinAdapters } from './register.js';

interface Fixture {
  /** relative path → source. */
  files: Record<string, string>;
  /** the subset handed to `analyze` (discovery is covered by adapter tests). */
  analyze: string[];
}

const PYTHON: Fixture = {
  files: {
    'app.py': `
from engine import Engine
from helpers import shout
from vendor import Thing
import os

class App:
    def __init__(self, engine: Engine):
        self.engine = engine
        self.ready = False

    async def run(self) -> str:
        self.prepare()
        await self.engine.spin()
        os.getpid()
        Thing()
        mystery()
        return shout("x")

    def prepare(self):
        self.ready = True

def main():
    return App(Engine())
`,
    'engine.py': `
class Engine:
    def __init__(self):
        self.rpm = 0

    async def spin(self) -> int:
        self.rpm += 1
        return self.rpm

def ignite(e: Engine):
    e.spin()
`,
    'helpers.py': `
def shout(text):
    return text
`,
  },
  analyze: ['app.py', 'engine.py', 'helpers.py'],
};

const TYPESCRIPT: Fixture = {
  files: {
    'app.ts': `
import { Engine } from './engine.js';
import { shout } from './helpers.js';
import * as fs from 'node:fs';

export class App {
  private engine: Engine;
  ready = false;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  async run(): Promise<void> {
    this.prepare();
    await this.engine.spin();
    fs.readFileSync('x');
    const wheel = new Wheel();
    mystery();
    shout('x');
  }

  prepare(): void {
    this.ready = true;
  }
}

export function main(): void {
  const app = new App(new Engine());
  app.run();
}
`,
    'engine.ts': `
export class Engine {
  rpm = 0;
  async spin(): Promise<number> {
    this.rpm += 1;
    return this.rpm;
  }
}
export function ignite(e: Engine): void {
  e.spin();
}
`,
    'helpers.ts': `
export function shout(text: string): string {
  return text;
}
`,
  },
  analyze: ['app.ts', 'engine.ts', 'helpers.ts'],
};

const GO: Fixture = {
  files: {
    'car.go': `
package main

import "fmt"

type Car struct {
	Engine *Engine
	name   string
}

func (c *Car) Drive(other *Engine) {
	c.Start()
	c.Engine.Spin()
	other.Spin()
	fmt.Println("driving")
	helper()
	c.name = "moving"
	mystery()
}

func (c *Car) Start() {}

func helper() {}
`,
    'engine.go': `
package main

type Engine struct {
	rpm int
}

func (e *Engine) Spin() {
	e.rpm = e.rpm + 1
}
`,
  },
  analyze: ['car.go', 'engine.go'],
};

const RUST: Fixture = {
  files: {
    'src/app.rs': `
use crate::engine::Engine;
use crate::helpers::shout;
use std::collections::HashMap;

pub struct App {
    engine: Engine,
}

impl App {
    pub fn new(engine: Engine) -> Self {
        shout("built");
        App { engine }
    }

    pub async fn run(&mut self) {
        self.prepare();
        self.engine.spin().await;
        let e = Engine::new();
        let m: HashMap<u32, u32> = HashMap::new();
        println!("running");
        mystery();
    }

    fn prepare(&self) {}
}

pub fn launch(app: &mut App) {
    app.prepare();
}
`,
    'src/engine.rs': `
pub struct Engine {
    pub rpm: u32,
}

impl Engine {
    pub fn new() -> Self {
        Engine { rpm: 0 }
    }

    pub async fn spin(&mut self) -> u32 {
        self.rpm += 1;
        self.rpm
    }
}
`,
    'src/helpers.rs': `
pub fn shout(text: &str) -> String {
    text.to_uppercase()
}
`,
  },
  analyze: ['src/app.rs', 'src/engine.rs', 'src/helpers.rs'],
};

const SHELL: Fixture = {
  files: {
    'scripts/deploy.sh': `#!/bin/bash

build() {
  echo "building"
  lint
}

deploy() {
  build
  aws s3 sync . s3://bucket
}
`,
    'lib/util.bash': `
function lint {
  shellcheck deploy.sh
}
`,
  },
  analyze: ['scripts/deploy.sh', 'lib/util.bash'],
};

/**
 * Generic-tier fixtures. Smaller than the full-tier ones above because a generic
 * adapter declares less — but held to the same bidirectional standard: whatever
 * the config claims, the fixture must actually produce.
 */
const KOTLIN: Fixture = {
  files: {
    'demo/app.kt': `package demo

import demo.engine.Engine
import kotlin.math.max

class App {
    fun run(): String {
        this.prepare()
        max(1, 2)
        mystery()
        Engine()
        return shout("x")
    }

    private fun prepare(): String = "ready"
}

fun shout(text: String): String = text
`,
    'demo/engine.kt': `package demo.engine

class Engine {
    fun spin(): Int = 1
}
`,
  },
  analyze: ['demo/app.kt', 'demo/engine.kt'],
};

const SCALA: Fixture = {
  files: {
    'demo/app.scala': `package demo

import demo.engine.Engine
import scala.math.max

class App {
  def run(): String = {
    this.prepare()
    max(1, 2)
    mystery()
    new Engine()
    shout("x")
  }

  private def prepare(): String = "ready"
}

def shout(text: String): String = text
`,
    'demo/engine.scala': `package demo.engine

class Engine {
  def spin(): Int = 1
}
`,
  },
  analyze: ['demo/app.scala', 'demo/engine.scala'],
};

const ZIG: Fixture = {
  files: {
    'app.zig': `pub fn run() void {
    prepare();
    mystery();
}

fn prepare() void {}
`,
  },
  analyze: ['app.zig'],
};

const OBJC: Fixture = {
  files: {
    'app.m': `#import "Logger.h"

@implementation App
- (void)run {
    [self prepare];
    [Logger warn];
    shout(@"x");
    NSLog(@"%@", @"hi");
}

- (void)prepare {
}
@end

void shout(NSString *text) {
}
`,
  },
  analyze: ['app.m'],
};

const OCAML: Fixture = {
  files: {
    'app.ml': `open Logger

let prepare y = y

let run x =
  let z = prepare x in
  Logger.warn z;
  String.length z
`,
  },
  analyze: ['app.ml'],
};

const FIXTURES: Record<string, Fixture> = {
  python: PYTHON,
  typescript: TYPESCRIPT,
  go: GO,
  rust: RUST,
  shell: SHELL,
  kotlin: KOTLIN,
  scala: SCALA,
  zig: ZIG,
  objc: OBJC,
  ocaml: OCAML,
};

function writeFixture(fixture: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-cap-'));
  for (const [rel, source] of Object.entries(fixture.files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

registerBuiltinAdapters();

describe('registered adapters', () => {
  it('every registered language has a capability fixture', () => {
    expect(availableLanguages()).toEqual(Object.keys(FIXTURES).sort());
  });
});

describe.each(Object.keys(FIXTURES))('%s capabilities', (language) => {
  let adapter: LanguageAdapter;
  let analysis: ModuleAnalysis;
  let produced: Set<CallType>;

  beforeAll(async () => {
    adapter = getAdapter(language);
    const fixture = FIXTURES[language];
    if (!fixture) throw new Error(`no fixture for ${language}`);
    analysis = await adapter.analyze(fixture.analyze, writeFixture(fixture));
    produced = new Set(analysis.edges.map((e) => e.callType));
  });

  it('produces a non-empty graph (so the comparison below means something)', () => {
    expect(analysis.functions.length).toBeGreaterThan(0);
    expect(analysis.edges.length).toBeGreaterThan(0);
  });

  it('produces only callTypes it declares', () => {
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    const undeclared = [...produced].filter((t) => !declared.has(t)).sort();
    expect(undeclared).toEqual([]);
  });

  it('produces every callType it declares (no over-claiming)', () => {
    const missing = adapter.capabilities.callTypes.filter((t) => !produced.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it('declares statementSpans exactly when it implements them', () => {
    expect(adapter.capabilities.statementSpans).toBe(typeof adapter.statementSpans === 'function');
  });

  it('declares selfAttrs exactly when the fixture reports any', () => {
    const reported = analysis.functions.some(
      (f) => f.selfAttrsRead.length > 0 || f.selfAttrsWritten.length > 0,
    );
    expect(adapter.capabilities.selfAttrs).toBe(reported);
  });

  it('declares a known tier', () => {
    expect(['full', 'generic']).toContain(adapter.capabilities.tier);
  });
});

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
source "$(dirname "$0")/../lib/util.bash"

build() {
  echo "building"
  lint
}

deploy() {
  build
  ./scripts/release.sh
  "$RUNNER" package
  aws s3 sync . s3://bucket
}
`,
    'scripts/release.sh': `#!/bin/bash
echo releasing
`,
    'lib/util.bash': `
function lint {
  shellcheck deploy.sh
}
`,
  },
  analyze: ['scripts/deploy.sh', 'scripts/release.sh', 'lib/util.bash'],
};

const JAVA: Fixture = {
  files: {
    'app/App.java': `package app;

import engine.Engine;
import vendor.Widget;

public class App {
    private Engine engine;

    public App(Engine engine) {
        this.engine = engine;
    }

    public void run() {
        this.prepare();
        this.engine.spin();
        Helpers.greet("x");
        Engine local = new Engine();
        local.spin();
        Widget w = new Widget();
        w.poke();
        mystery();
    }

    private void prepare() {}
}
`,
    'app/Helpers.java': `package app;

public class Helpers {
    public static String greet(String text) {
        return text;
    }
}
`,
    'engine/Engine.java': `package engine;

public class Engine {
    private int rpm;

    public void spin() {
        this.rpm += 1;
    }
}
`,
  },
  analyze: ['app/App.java', 'app/Helpers.java', 'engine/Engine.java'],
};

const CSHARP: Fixture = {
  files: {
    // No `using` names Demo.Engines: App.cs already lives in it, and C# resolves
    // same-namespace types without one.
    'src/App.cs': `using System;
using Demo.Tools;

namespace Demo.Engines
{
    public class App : EngineBase
    {
        private Engine engine;

        public App(Engine engine)
        {
            this.engine = engine;
        }

        public async Task Run(Engine other)
        {
            this.Prepare();
            this.engine.Spin();
            other.Spin();
            var made = new Engine();
            made.Spin();
            Helpers.Shout("x");
            this.Reset();
            var widget = new Widget();
            Console.WriteLine("hi");
            mystery.Poke();
        }

        private void Prepare()
        {
            this.engine = null;
        }
    }
}
`,
    'src/Motor.cs': `namespace Demo.Engines;

public class EngineBase
{
    protected int cycles;

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
}
`,
    'tools/Text.cs': `namespace Demo.Tools;

public static class Helpers
{
    public static string Shout(string text) => text;
}
`,
  },
  analyze: ['src/App.cs', 'src/Motor.cs', 'tools/Text.cs'],
};

const CPP: Fixture = {
  files: {
    // `engine.h` declares, `engine.cpp` defines: one node per function, and the
    // call from `app.cpp` must land on the definition.
    'src/engine.h': `#pragma once

namespace demo {

class Engine {
public:
    Engine();
    void spin();
    static int describe();
    int rpm_;
};

int ignite(Engine& e);

}  // namespace demo
`,
    'src/engine.cpp': `#include "engine.h"

namespace demo {

Engine::Engine() { this->rpm_ = 0; }

void Engine::spin() { this->rpm_ += 1; }

int Engine::describe() { return 1; }

int ignite(Engine& e) {
    e.spin();
    return 1;
}

}  // namespace demo
`,
    'src/app.cpp': `#include "engine.h"
#include <cstdio>

namespace demo {

class App {
public:
    explicit App(Engine* engine) : engine_(engine) {}

    void run(Engine& other) {
        this->prepare();
        this->engine_->spin();
        other.spin();
        Engine::describe();
        ignite(other);
        Engine* made = new Engine();
        made->spin();
        Widget* w = new Widget();
        w->poke();
        printf("x");
        mystery.poke();
    }

    void prepare() { this->engine_ = nullptr; }

private:
    Engine* engine_;
};

}  // namespace demo
`,
  },
  analyze: ['src/app.cpp', 'src/engine.cpp', 'src/engine.h'],
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

const RUBY: Fixture = {
  files: {
    'app.rb': `require_relative 'engine'
require_relative 'helpers'

module Demo
  class App
    attr_accessor :ready

    def initialize(engine)
      @engine = engine
      @cfg = Engine.new
    end

    def run
      prepare
      @cfg.spin
      local = Engine.new
      local.spin
      App.build
      widget = Widget.new
      widget.poke
      shout('x')
      send(:mystery)
      puts 'done'
    end

    def self.build
      new(Engine.new)
    end

    def prepare
      @ready = true
    end
  end
end
`,
    'engine.rb': `module Demo
  class Engine
    attr_reader :rpm

    def initialize
      @rpm = 0
    end

    def spin
      @rpm += 1
    end
  end
end
`,
    'helpers.rb': `def shout(text)
  text
end
`,
  },
  analyze: ['app.rb', 'engine.rb', 'helpers.rb'],
};

const PHP: Fixture = {
  files: {
    'src/Engine.php': `<?php

namespace App\\Engine;

class Engine
{
    private int $rpm = 0;

    public function __construct()
    {
        $this->rpm = 0;
    }

    public function spin(): int
    {
        $this->rpm += 1;
        return $this->rpm;
    }

    public static function describe(): string
    {
        return 'engine';
    }
}

function ignite(Engine $e): int
{
    return $e->spin();
}
`,
    'src/Motor.php': `<?php

namespace App\\Billing;

class Base
{
    protected int $cycles = 0;

    public function reset(): void
    {
        $this->cycles = 0;
    }
}
`,
    'src/App.php': `<?php

namespace App\\Billing;

use App\\Engine\\Engine;
use Vendor\\Widget;

class App extends Base
{
    private Engine $engine;
    protected ?Widget $widget = null;
    public int $hits = 0;

    public function __construct(Engine $engine)
    {
        $this->engine = $engine;
    }

    public function run(Engine $other): void
    {
        $this->prepare();
        $this->engine->spin();
        $other->spin();
        $this->widget->poke();
        Engine::describe();
        parent::reset();
        $made = new Engine();
        $made->spin();
        $w = new Widget();
        mystery();
        $name = 'spin';
        $made->$name();
        $this->hits += 1;
    }

    private function prepare(): void
    {
        $this->hits = 0;
    }
}
`,
  },
  analyze: ['src/App.php', 'src/Motor.php', 'src/Engine.php'],
};

const DART: Fixture = {
  files: {
    'lib/engine.dart': `
mixin Loggable {
  void log(String message) {}
}

class Engine with Loggable {
  int rpm = 0;

  Engine();

  void spin() {
    this.rpm += 1;
    log('spin');
  }

  static Engine fresh() => Engine();
}
`,
    'lib/app.dart': `
import 'engine.dart';
import 'package:flutter/material.dart' as material;
import 'util/text.dart';

class App {
  final Engine engine;

  App(this.engine);

  Future<void> run(Engine other) async {
    this.prepare();
    this.engine.spin();
    other.spin();
    var made = Engine();
    made.spin();
    Engine.fresh();
    shout('x');
    material.showDialog();
    Widget();
    mystery.doStuff();
  }

  void prepare() {
    this.engine.spin();
  }
}
`,
    'lib/util/text.dart': `
String shout(String text) => text;
`,
  },
  analyze: ['lib/engine.dart', 'lib/app.dart', 'lib/util/text.dart'],
};

const SWIFT: Fixture = {
  files: {
    // `Engine.swift` declares, `Extras.swift` EXTENDS: an extension member must
    // land on the extended type and be reachable from a third file.
    'Sources/Engine.swift': `import Foundation

public protocol Runner {
    func start()
}

extension Runner {
    func ping() {
        self.start()
    }
}

public class EngineBase {
    var cycles: Int = 0

    func reset() {
        self.cycles = 0
    }
}

public class Engine: EngineBase, Runner {
    public var rpm: Int = 0

    public init() {
        self.rpm = 0
    }

    public func spin() {
        self.rpm += 1
    }

    public func start() { }

    public static func describe() -> String {
        return "engine"
    }
}

public func shout(_ text: String) -> String {
    return text
}
`,
    'Sources/Extras.swift': `extension Engine {
    public func idle() -> Int {
        self.spin()
        return self.rpm
    }
}
`,
    'Sources/App.swift': `import Foundation

public class App: EngineBase, Runner {
    private let engine: Engine

    public init(engine: Engine) {
        self.engine = engine
    }

    public func start() { }

    public func run(other: Engine) {
        self.prepare()
        self.engine.spin()
        self.engine.idle()
        other.spin()
        let made = Engine()
        made.spin()
        Engine.describe()
        self.reset()
        self.ping()
        shout("x")
        Foundation.NSLog("hi")
        let widget = Widget()
        mystery.poke()
    }

    private func prepare() { }
}
`,
  },
  analyze: ['Sources/Engine.swift', 'Sources/Extras.swift', 'Sources/App.swift'],
};

const SOLIDITY: Fixture = {
  files: {
    'src/App.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Engine, EngineBase} from "./Engine.sol";
import {MathLib} from "./MathLib.sol";
import {Widget} from "./vendor/Widget.sol";

contract App is EngineBase {
    Engine public engine;
    uint256 public total;

    modifier onlyReady() {
        require(total > 0, "not ready");
        _;
    }

    constructor(Engine e) {
        engine = e;
    }

    function run(Engine other) external onlyReady returns (uint256) {
        prepare();
        reset();
        engine.spin();
        other.spin();
        total = MathLib.double(total);
        Engine made = new Engine();
        made.spin();
        Widget w = new Widget();
        mystery();
        return total;
    }

    function prepare() public {
        cycles = cycles + 1;
        total = 0;
    }
}
`,
    'src/Engine.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract EngineBase {
    uint256 internal cycles;

    function reset() internal virtual {
        cycles = 0;
    }
}

contract Engine is EngineBase {
    uint256 public rpm;

    constructor() {
        rpm = 0;
    }

    function spin() public {
        rpm = rpm + 1;
    }
}
`,
    'src/MathLib.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library MathLib {
    function double(uint256 a) internal pure returns (uint256) {
        return a * 2;
    }
}
`,
  },
  analyze: ['src/App.sol', 'src/Engine.sol', 'src/MathLib.sol'],
};

const FIXTURES: Record<string, Fixture> = {
  python: PYTHON,
  typescript: TYPESCRIPT,
  go: GO,
  rust: RUST,
  shell: SHELL,
  java: JAVA,
  csharp: CSHARP,
  cpp: CPP,
  ruby: RUBY,
  php: PHP,
  dart: DART,
  swift: SWIFT,
  solidity: SOLIDITY,
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

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
import { RustAdapter } from './rust.js';

const ENGINE_RS = `
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
`;

const HELPERS_RS = `
pub fn shout(text: &str) -> String {
    text.to_uppercase()
}
`;

const APP_RS = `
use crate::engine::Engine;
use crate::helpers::shout;
use std::collections::HashMap;

pub struct App {
    engine: Engine,
    gearbox: Gearbox,
}

impl App {
    pub fn new(engine: Engine) -> Self {
        shout("built");
        App { engine, gearbox: Gearbox {} }
    }

    pub async fn run(&mut self) {
        self.prepare();
        self.engine.spin().await;
        self.gearbox.shift();
        let e = Engine::new();
        let m: HashMap<u32, u32> = HashMap::new();
        println!("running");
        self.missing();
    }

    #[inline]
    fn prepare(&self) {}
}

pub struct Gearbox {}

pub fn launch(app: &mut App) {
    app.prepare();
    helpers_only();
}
`;

const UTIL_MOD_RS = `
pub fn tidy() {}
`;

describe('RustAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-rust-'));
    mkdirSync(join(root, 'src', 'util'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.rs'), APP_RS);
    writeFileSync(join(root, 'src', 'engine.rs'), ENGINE_RS);
    writeFileSync(join(root, 'src', 'helpers.rs'), HELPERS_RS);
    writeFileSync(join(root, 'src', 'util', 'mod.rs'), UTIL_MOD_RS);
    const adapter = new RustAdapter();
    analysis = await adapter.analyze(
      ['src/app.rs', 'src/engine.rs', 'src/helpers.rs', 'src/util/mod.rs'],
      root,
    );
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('extracts impl methods and free functions with :: ids', () => {
    const run = fn('src::app::App::run');
    expect(run?.isMethod).toBe(true);
    expect(run?.isAsync).toBe(true);
    expect(run?.className).toBe('App');
    expect(fn('src::app::launch')?.isMethod).toBe(false);
    expect(fn('src::engine::Engine::spin')?.isAsync).toBe(true);
  });

  it('drops mod/lib/main segments from module ids', () => {
    expect(fn('src::util::tidy')).toBeDefined();
  });

  it('records attributes as decorators', () => {
    expect(fn('src::app::App::prepare')?.decorators).toContain('inline');
  });

  it('tracks self attribute reads and writes', () => {
    const spin = fn('src::engine::Engine::spin');
    expect(spin?.selfAttrsWritten).toContain('rpm');
    expect(spin?.selfAttrsRead).toContain('rpm');
  });

  it('resolves self.m() to self_method', () => {
    expect(edge('src::app::App::run', 'src::app::App::prepare')?.callType).toBe('self_method');
  });

  it('resolves self.field.m() through learned field types with .await', () => {
    const e = edge('src::app::App::run', 'src::engine::Engine::spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.isAwait).toBe(true);
  });

  it('resolves A::b() to scanned types cross-module (constructor names)', () => {
    const e = edge('src::app::App::run', 'src::engine::Engine::new');
    expect(e?.callType).toBe('internal_constructor');
    const local = edge('src::app::App::run', 'src::app::Gearbox::shift');
    expect(local?.callType).toBe('self_attr_method');
  });

  it('resolves imported free functions when unique by (module tail, name)', () => {
    const e = edge('src::app::App::new', 'src::helpers::shout');
    expect(e?.callType).toBe('internal_func');
  });

  it('resolves param.m() through typed parameters', () => {
    expect(edge('src::app::launch', 'src::app::App::prepare')?.callType).toBe('param_method');
  });

  it('routes external paths and macros to boundary', () => {
    const hashmap = edge('src::app::App::run', 'boundary:std::collections::HashMap::new');
    expect(hashmap?.callType).toBe('boundary_constructor');
    const macro = edge('src::app::App::run', 'boundary:println!');
    expect(macro?.callType).toBe('boundary');
    expect(macro?.isAwait).toBe(false);
  });

  it('marks unknown calls unresolved', () => {
    const missing = analysis.edges.find((e) => e.raw === 'self.missing');
    expect(missing?.callType).toBe('unresolved');
    const only = analysis.edges.find((e) => e.raw === 'helpers_only');
    expect(only?.callType).toBe('unresolved');
  });
});

describe('RustAdapter — deep-nesting defenses (pass 2)', () => {
  it('does not stack-overflow on deeply nested inline modules (was recursive scanInto)', async () => {
    const depth = 4000;
    const src = `${'mod m {\n'.repeat(depth)}fn deep() {}\n${'}\n'.repeat(depth)}`;
    const root = mkdtempSync(join(tmpdir(), 'hb-rs-mod-'));
    writeFileSync(join(root, 'a.rs'), src);
    const result = await new RustAdapter().analyze(['a.rs'], root);
    expect(result.functions.some((f) => f.name === 'deep')).toBe(true);
  });

  it('does not stack-overflow on a deeply nested use-tree (was recursive collectUse)', async () => {
    const depth = 3000;
    const src = `use ${'a::{'.repeat(depth)}x${'}'.repeat(depth)};\nfn f() {}\n`;
    const root = mkdtempSync(join(tmpdir(), 'hb-rs-use-'));
    writeFileSync(join(root, 'a.rs'), src);
    const result = await new RustAdapter().analyze(['a.rs'], root);
    expect(result.functions.some((f) => f.name === 'f')).toBe(true);
  });

  it('inline-mod prefixing and first-wins are unchanged by the iterative rewrite', async () => {
    const src = `
mod outer {
    struct S;
    impl S { fn m(&self) -> i32 { 0 } }
    mod inner {
        fn helper() -> i32 { 1 }
    }
    fn use_inner() -> i32 { helper() }
}
`;
    const root = mkdtempSync(join(tmpdir(), 'hb-rs-prefix-'));
    writeFileSync(join(root, 'lib.rs'), src);
    const result = await new RustAdapter().analyze(['lib.rs'], root);
    expect(result.functions.find((f) => f.id === 'lib::outer::S::m')).toBeDefined();
    expect(result.functions.find((f) => f.id === 'lib::outer::inner::helper')).toBeDefined();
    expect(result.functions.find((f) => f.id === 'lib::outer::use_inner')).toBeDefined();
  });
});

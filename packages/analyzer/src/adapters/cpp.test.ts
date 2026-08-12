import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
import { CppAdapter } from './cpp.js';

function writeRepo(files: Record<string, string>, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

/**
 * A C++ tree with the two layouts that matter: `engine.h`/`engine.cpp` beside
 * each other (one module), and `include/core/spinner.h` split from
 * `src/spinner.cpp` (two modules linked only by the `#include`).
 */
const CPP_FILES: Record<string, string> = {
  'src/engine.h': `#ifndef DEMO_ENGINE_H
#define DEMO_ENGINE_H

namespace demo {

class Engine {
public:
  Engine();
  void spin();
  static int describe();
  int cycles_;
};

class Loader {
public:
  void load_all();
};

class Turbo : public Engine, public Loader {
public:
  void boost();
};

int ignite(Engine& e);

}  // namespace demo

#endif
`,
  'src/engine.cpp': `#include "engine.h"

namespace demo {

Engine::Engine() {
  this->cycles_ = 0;
}

void Engine::spin() {
  this->cycles_ += 1;
}

int Engine::describe() {
  return 7;
}

void Loader::load_all() {}

void Turbo::boost() {
  this->spin();
  load_all();
}

int ignite(Engine& e) {
  e.spin();
  return 1;
}

}  // namespace demo
`,
  'src/app.h': `#pragma once
#include "engine.h"

namespace demo {

class App {
public:
  explicit App(Engine* engine);
  void run(Engine& other);
  void prepare();

private:
  Engine* engine_;
  int count_;
};

}  // namespace demo
`,
  'src/app.cpp': `#include "app.h"
#include "core/spinner.h"
#include "alpha/config.h"
#include "beta/config.h"
#include "util.h"
#include <vector>
#include <cstdio>

namespace demo {

App::App(Engine* engine) : engine_(engine) {
  this->count_ = 0;
}

void App::run(Engine& other) {
  this->prepare();
  prepare();
  this->engine_->spin();
  engine_->spin();
  other.spin();
  Engine local;
  local.spin();
  auto made = Engine();
  made.spin();
  Engine* heap = new Engine();
  heap->spin();
  auto* fresh = new Engine();
  fresh->spin();
  Engine::describe();
  spin_once(1);
  never_defined(2);
  ignite(other);
  demo::ignite(other);
  twice<int>(2);
  alpha::Config a;
  a.load();
  beta::Config b;
  b.load();
  std::vector<int> v;
  v.push_back(1);
  Widget* w = new Widget();
  w->poke();
  this->count_ += 1;
  int c = this->count_;
  mystery.poke();
  printf("%d", c);
}

void App::prepare() {
  this->count_ = 0;
}

}  // namespace demo
`,
  'src/util.h': `#pragma once

namespace demo {

template <typename T>
T twice(T v) {
  return v + v;
}

}  // namespace demo
`,
  'include/core/spinner.h': `#pragma once

int spin_once(int n);
int never_defined(int n);
`,
  'src/spinner.cpp': `#include "core/spinner.h"

int spin_once(int n) {
  return n + 1;
}
`,
  'src/alpha/config.h': `#pragma once

namespace alpha {

class Config {
public:
  void load();
};

}  // namespace alpha
`,
  'src/alpha/config.cpp': `#include "config.h"

namespace alpha {

void Config::load() {}

}  // namespace alpha
`,
  'src/beta/config.h': `#pragma once

namespace beta {

class Config {
public:
  void load();
};

}  // namespace beta
`,
  'src/beta/config.cpp': `#include "config.h"

namespace beta {

void Config::load() {}

}  // namespace beta
`,
  // Unparseable on purpose: it must not take its neighbours down.
  'src/broken.cpp': `class Broken {
  void m( {
    this->
};
`,
  // Discovery must not see any of these.
  'build/generated.cpp': `void ghost() {}
`,
  'cmake-build-debug/made.cpp': `void made() {}
`,
  'CMakeFiles/probe.c': `int probe(void) { return 0; }
`,
  'src/proto/thing.pb.cc': `void generated_thing() {}
`,
  'src/proto/thing.pb.h': `void generated_thing();
`,
};

const CPP_ANALYZED = [
  'include/core/spinner.h',
  'src/alpha/config.cpp',
  'src/alpha/config.h',
  'src/app.cpp',
  'src/app.h',
  'src/beta/config.cpp',
  'src/beta/config.h',
  'src/broken.cpp',
  'src/engine.cpp',
  'src/engine.h',
  'src/spinner.cpp',
  'src/util.h',
];

describe('CppAdapter — C++', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new CppAdapter();

  beforeAll(async () => {
    root = writeRepo(CPP_FILES, 'hb-cpp-');
    analysis = await adapter.analyze(CPP_ANALYZED, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  /** Call sites are identified by their source text, which is unique per fixture. */
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers C and C++ sources but not build output or generated protobuf', () => {
    const files = adapter.discover(root);
    expect(files).toContain('src/app.cpp');
    expect(files).toContain('src/app.h');
    expect(files).toContain('include/core/spinner.h');
    expect(files).not.toContain('build/generated.cpp');
    expect(files).not.toContain('cmake-build-debug/made.cpp');
    expect(files).not.toContain('CMakeFiles/probe.c');
    expect(files).not.toContain('src/proto/thing.pb.cc');
    expect(files).not.toContain('src/proto/thing.pb.h');
  });

  it('gives a declared-and-defined function exactly one node, owned by the definition', () => {
    const nodes = analysis.functions.filter((f) => f.name === 'spin');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe('src.engine.demo.Engine.spin');
    expect(nodes[0]?.file).toBe('src/engine.cpp');
  });

  it('attaches an out-of-line definition to its class, not to the free functions', () => {
    const spin = fn('src.engine.demo.Engine.spin');
    expect(spin?.className).toBe('Engine');
    expect(spin?.isMethod).toBe(true);
    expect(fn('src.engine.demo.spin')).toBeUndefined();
  });

  it('records a free function declared in a header and defined in a sibling .cpp once', () => {
    expect(analysis.functions.filter((f) => f.name === 'spin_once')).toHaveLength(1);
    expect(fn('src.spinner.spin_once')?.file).toBe('src/spinner.cpp');
  });

  it('gives a never-defined declaration a node at its declaration', () => {
    const node = fn('include.core.spinner.never_defined');
    expect(node?.file).toBe('include/core/spinner.h');
    expect(node?.isMethod).toBe(false);
  });

  it('resolves a free-function call across the header/implementation boundary', () => {
    const e = raw('src.app.demo.App.run', 'spin_once');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('src.spinner.spin_once');
  });

  it('resolves a call to a declared-but-never-defined function at its declaration', () => {
    const e = raw('src.app.demo.App.run', 'never_defined');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('include.core.spinner.never_defined');
  });

  it('resolves this->m() and bare m() inside a class to self_method', () => {
    expect(raw('src.app.demo.App.run', 'this->prepare')?.callType).toBe('self_method');
    expect(raw('src.app.demo.App.run', 'this->prepare')?.calleeId).toBe('src.app.demo.App.prepare');
    expect(raw('src.app.demo.App.run', 'prepare')?.callType).toBe('self_method');
    expect(raw('src.app.demo.App.run', 'prepare')?.calleeId).toBe('src.app.demo.App.prepare');
  });

  it('resolves methods inherited from scanned base classes, including the second base', () => {
    expect(raw('src.engine.demo.Turbo.boost', 'this->spin')?.callType).toBe('self_method');
    expect(raw('src.engine.demo.Turbo.boost', 'this->spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
    expect(raw('src.engine.demo.Turbo.boost', 'load_all')?.callType).toBe('self_method');
    expect(raw('src.engine.demo.Turbo.boost', 'load_all')?.calleeId).toBe('src.engine.demo.Loader.load_all');
  });

  it('resolves this->field->m() and bare field->m() through the declared field type', () => {
    expect(raw('src.app.demo.App.run', 'this->engine_->spin')?.callType).toBe('self_attr_method');
    expect(raw('src.app.demo.App.run', 'this->engine_->spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
    expect(raw('src.app.demo.App.run', 'engine_->spin')?.callType).toBe('self_attr_method');
    expect(raw('src.app.demo.App.run', 'engine_->spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
  });

  it('resolves a reference parameter with . and a pointer local with ->', () => {
    expect(raw('src.app.demo.App.run', 'other.spin')?.callType).toBe('param_method');
    expect(raw('src.app.demo.App.run', 'other.spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
    expect(raw('src.app.demo.App.run', 'heap->spin')?.callType).toBe('param_method');
    expect(raw('src.app.demo.App.run', 'heap->spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
  });

  it('resolves a plainly typed local and an auto local initialised from a constructor', () => {
    expect(raw('src.app.demo.App.run', 'local.spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
    expect(raw('src.app.demo.App.run', 'made.spin')?.callType).toBe('param_method');
    expect(raw('src.app.demo.App.run', 'made.spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
  });

  it('resolves an auto local initialised from new', () => {
    expect(raw('src.app.demo.App.run', 'fresh->spin')?.callType).toBe('param_method');
    expect(raw('src.app.demo.App.run', 'fresh->spin')?.calleeId).toBe('src.engine.demo.Engine.spin');
  });

  it('resolves Type::staticM() to the internal function that defines it', () => {
    const e = raw('src.app.demo.App.run', 'Engine::describe');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('src.engine.demo.Engine.describe');
  });

  it('resolves a namespace-qualified free call and its unqualified twin alike', () => {
    expect(raw('src.app.demo.App.run', 'demo::ignite')?.callType).toBe('internal_func');
    expect(raw('src.app.demo.App.run', 'demo::ignite')?.calleeId).toBe('src.engine.demo.ignite');
    expect(raw('src.app.demo.App.run', 'ignite')?.calleeId).toBe('src.engine.demo.ignite');
  });

  it('keeps two same-named types in different namespaces apart', () => {
    expect(raw('src.app.demo.App.run', 'a.load')?.calleeId).toBe('src.alpha.config.alpha.Config.load');
    expect(raw('src.app.demo.App.run', 'b.load')?.calleeId).toBe('src.beta.config.beta.Config.load');
  });

  it('resolves new on a scanned class and on an unknown one', () => {
    expect(raw('src.app.demo.App.run', 'new Engine()')?.callType).toBe('internal_constructor');
    expect(raw('src.app.demo.App.run', 'new Engine()')?.calleeId).toBe('src.engine.demo.Engine.Engine');
    expect(raw('src.app.demo.App.run', 'new Widget()')?.callType).toBe('boundary_constructor');
    expect(raw('src.app.demo.App.run', 'new Widget()')?.calleeId).toBe('boundary:Widget');
  });

  it('treats a value-initialised scanned type as a constructor call', () => {
    const e = raw('src.app.demo.App.run', 'Engine');
    expect(e?.callType).toBe('internal_constructor');
    expect(e?.calleeId).toBe('src.engine.demo.Engine.Engine');
  });

  it('sends a call through a system header type to boundary', () => {
    const e = raw('src.app.demo.App.run', 'v.push_back');
    expect(e?.callType).toBe('boundary');
    expect(e?.calleeId).toBe('boundary:std::vector.push_back');
  });

  it('sends a bare call declared in no scanned file to boundary when a header is unscanned', () => {
    const e = raw('src.app.demo.App.run', 'printf');
    expect(e?.callType).toBe('boundary');
    expect(e?.calleeId).toBe('boundary:printf');
  });

  it('sends a call on a known-unscanned type to boundary', () => {
    const e = raw('src.app.demo.App.run', 'w->poke');
    expect(e?.callType).toBe('boundary');
    expect(e?.calleeId).toBe('boundary:Widget.poke');
  });

  it('leaves a call on an untyped receiver unresolved', () => {
    const e = raw('src.app.demo.App.run', 'mystery.poke');
    expect(e?.callType).toBe('unresolved');
    expect(e?.calleeId).toBe('unresolved:mystery.poke');
  });

  it('resolves a call to a template function by its bare name (best effort)', () => {
    const e = raw('src.app.demo.App.run', 'twice<int>');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('src.util.demo.twice');
  });

  it('tracks member reads and writes through this-> and bare names', () => {
    const run = fn('src.app.demo.App.run');
    expect(run?.selfAttrsWritten).toEqual(['count_']);
    expect(run?.selfAttrsRead).toEqual(['count_', 'engine_']);
    expect(fn('src.app.demo.App.App')?.selfAttrsWritten).toEqual(['count_', 'engine_']);
    expect(fn('src.engine.demo.Engine.spin')?.selfAttrsRead).toEqual(['cycles_']);
    expect(fn('src.engine.demo.Engine.spin')?.selfAttrsWritten).toEqual(['cycles_']);
  });

  it('names a constructor after its class so the graph can find it', () => {
    const ctor = fn('src.app.demo.App.App');
    expect(ctor?.name).toBe('App');
    expect(ctor?.className).toBe('App');
  });

  it('marks a static member function as non-instance while keeping its class', () => {
    const describe_ = fn('src.engine.demo.Engine.describe');
    expect(describe_?.isMethod).toBe(false);
    expect(describe_?.className).toBe('Engine');
  });

  it('records a single-line signature and no async', () => {
    expect(fn('src.app.demo.App.run')?.signature).toBe('void App::run(Engine& other)');
    expect(analysis.functions.every((f) => !f.isAsync)).toBe(true);
  });

  it('skips a file that fails to parse without losing its neighbours', () => {
    expect(analysis.functions.filter((f) => f.file === 'src/broken.cpp')).toEqual([]);
    expect(fn('src.engine.demo.Engine.spin')).toBeDefined();
    expect(fn('src.app.demo.App.run')).toBeDefined();
  });
});

/**
 * Same-named types in different namespaces whose out-of-line definitions share
 * ONE .cpp — so both get the same moduleId, and only the namespace inside the
 * qualname keeps their ids apart. Cross-file twins (in the big fixture above)
 * cannot catch this: differing moduleIds hide the collision.
 */
const TWIN_FILES: Record<string, string> = {
  'audio.hpp': `#pragma once
namespace audio { class Engine { public: int spin(); private: int rpm_ = 0; }; }
`,
  'video.hpp': `#pragma once
namespace video { class Engine { public: int spin(); private: int fps_ = 0; }; }
`,
  'impl.cpp': `#include "audio.hpp"
#include "video.hpp"
namespace audio { int Engine::spin() { rpm_ += 1; return rpm_; } }
namespace video { int Engine::spin() { fps_ += 2; return fps_; } }
void driveAudio() { audio::Engine e; e.spin(); }
void driveVideo() { video::Engine e; e.spin(); }
namespace { void hidden() {} }
namespace outer { namespace inner { void deep() {} } }
void global_fn() { hidden(); outer::inner::deep(); }
`,
};

describe('CppAdapter — same-file namespace twins', () => {
  let analysis: ModuleAnalysis;
  const adapter = new CppAdapter();

  beforeAll(async () => {
    const root = writeRepo(TWIN_FILES, 'hb-cpp-twin-');
    analysis = await adapter.analyze(['audio.hpp', 'impl.cpp', 'video.hpp'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('keeps both twins as separate nodes instead of dropping one', () => {
    expect(analysis.functions.filter((f) => f.name === 'spin')).toHaveLength(2);
    expect(fn('impl.audio.Engine.spin')?.lineStart).toBe(3);
    expect(fn('impl.video.Engine.spin')?.lineStart).toBe(4);
  });

  it('puts the namespace in the qualname, per <moduleId>.<qualname>', () => {
    expect(fn('impl.audio.Engine.spin')?.qualname).toBe('audio.Engine.spin');
    expect(fn('impl.video.Engine.spin')?.qualname).toBe('video.Engine.spin');
    expect(fn('impl.audio.Engine.spin')?.className).toBe('Engine');
  });

  it('points callers of same-named methods at different targets', () => {
    expect(raw('impl.driveAudio', 'e.spin')?.calleeId).toBe('impl.audio.Engine.spin');
    expect(raw('impl.driveVideo', 'e.spin')?.calleeId).toBe('impl.video.Engine.spin');
    expect(raw('impl.driveAudio', 'e.spin')?.callType).toBe('param_method');
  });

  it('tracks each twin own member, not the other one', () => {
    expect(fn('impl.audio.Engine.spin')?.selfAttrsWritten).toEqual(['rpm_']);
    expect(fn('impl.video.Engine.spin')?.selfAttrsWritten).toEqual(['fps_']);
  });

  it('leaves global and anonymous-namespace ids without an empty segment', () => {
    for (const id of ['impl.driveAudio', 'impl.global_fn', 'impl.hidden']) {
      expect(fn(id), id).toBeDefined();
    }
    expect(analysis.functions.every((f) => !/\.\.|^\.|\.$/.test(f.id))).toBe(true);
    expect(analysis.functions.every((f) => !/\.\.|^\.|\.$/.test(f.qualname))).toBe(true);
    // An anonymous namespace names no scope, so its members stay at global scope.
    expect(fn('impl.hidden')?.qualname).toBe('hidden');
    expect(raw('impl.global_fn', 'hidden')?.calleeId).toBe('impl.hidden');
  });

  it('flattens a nested namespace into the qualname', () => {
    expect(fn('impl.outer.inner.deep')?.qualname).toBe('outer.inner.deep');
    expect(raw('impl.global_fn', 'outer::inner::deep')?.calleeId).toBe('impl.outer.inner.deep');
  });
});

/**
 * Pure C through the `cpp` grammar (the `.c` files below take the `c` grammar).
 * `engine.h` and `engine.c` share a basename, so they are one module; the
 * prototype in the header yields no node and the definition owns it.
 */
const C_FILES: Record<string, string> = {
  'c/engine.h': `#ifndef C_ENGINE_H
#define C_ENGINE_H

struct Engine {
  int rpm;
};

int spin(struct Engine* e);
void reset(struct Engine* e);
int never_implemented(void);

#endif
`,
  'c/engine.c': `#include "engine.h"

static int clamp(int v) {
  return v;
}

int spin(struct Engine* e) {
  e->rpm = clamp(e->rpm + 1);
  return e->rpm;
}

void reset(struct Engine* e) {
  e->rpm = 0;
}
`,
  'c/main.c': `#include <stdio.h>
#include "engine.h"

static int clamp(int v) {
  return v;
}

int main(void) {
  struct Engine e;
  reset(&e);
  spin(&e);
  clamp(3);
  never_implemented();
  printf("%d\\n", e.rpm);
  return 0;
}
`,
};

/**
 * Real headers are not clean parses. The C-linkage guard below opens a brace in
 * one preprocessor branch and closes it in another, which the grammar cannot
 * pair: measured, it swallows the whole rest of the file into a single ERROR
 * node. Since practically every portable C header carries that guard, losing
 * the file would gut the adapter on real trees.
 */
const MESSY_FILES: Record<string, string> = {
  'lib/api.h': `#pragma once
#define DECLARE_THING(N) void N();

#ifdef __cplusplus
extern "C" {
#endif

void c_entry(void);

#ifdef __cplusplus
}
#endif

namespace lib {

class Base {
public:
  virtual ~Base() = default;
  virtual void pure() = 0;
  void shared();
  void (*cb)(int);
};

}  // namespace lib
`,
  'lib/api.cpp': `#include "api.h"

namespace lib {

void Base::shared() {}

struct Impl : public Base {
  void pure() override {
    shared();
    cb(1);
  }
};

void drive() {
  Impl i;
  i.pure();
  c_entry();
}

}  // namespace lib
`,
};

describe('CppAdapter — recovery inside a broken parse', () => {
  let analysis: ModuleAnalysis;
  const adapter = new CppAdapter();

  beforeAll(async () => {
    const root = writeRepo(MESSY_FILES, 'hb-cpp-messy-');
    analysis = await adapter.analyze(['lib/api.cpp', 'lib/api.h'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('still finds declarations after a C-linkage guard defeats the parser', () => {
    expect(fn('lib.api.lib.Base.shared')).toBeDefined();
    expect(fn('lib.api.lib.Impl.pure')).toBeDefined();
    expect(fn('lib.api.lib.drive')).toBeDefined();
    // Declared only in the header, never defined: it keeps its own node.
    expect(fn('lib.api.c_entry')?.file).toBe('lib/api.h');
  });

  it('still resolves inheritance and calls through the recovered declarations', () => {
    expect(raw('lib.api.lib.Impl.pure', 'shared')?.callType).toBe('self_method');
    expect(raw('lib.api.lib.Impl.pure', 'shared')?.calleeId).toBe('lib.api.lib.Base.shared');
    expect(raw('lib.api.lib.drive', 'i.pure')?.calleeId).toBe('lib.api.lib.Impl.pure');
    expect(raw('lib.api.lib.drive', 'c_entry')?.calleeId).toBe('lib.api.c_entry');
  });

  it('leaves a call through a function-pointer member unresolved, not boundary', () => {
    expect(raw('lib.api.lib.Impl.pure', 'cb')?.callType).toBe('unresolved');
  });
});

describe('CppAdapter — pure C', () => {
  let analysis: ModuleAnalysis;
  const adapter = new CppAdapter();

  beforeAll(async () => {
    const root = writeRepo(C_FILES, 'hb-c-');
    analysis = await adapter.analyze(['c/engine.c', 'c/engine.h', 'c/main.c'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('gives every C function exactly one node, owned by the definition', () => {
    expect(fn('c.engine.spin')?.file).toBe('c/engine.c');
    expect(fn('c.engine.reset')?.file).toBe('c/engine.c');
    expect(analysis.functions.filter((f) => f.name === 'spin')).toHaveLength(1);
  });

  it('resolves a call across the header into the .c file that defines it', () => {
    expect(raw('c.main.main', 'reset')?.callType).toBe('internal_func');
    expect(raw('c.main.main', 'reset')?.calleeId).toBe('c.engine.reset');
    expect(raw('c.main.main', 'spin')?.calleeId).toBe('c.engine.spin');
  });

  it('prefers the calling file own static definition over a same-named sibling', () => {
    expect(raw('c.main.main', 'clamp')?.calleeId).toBe('c.main.clamp');
    expect(raw('c.engine.spin', 'clamp')?.calleeId).toBe('c.engine.clamp');
  });

  it('keeps a header-only prototype as the node when nothing defines it', () => {
    expect(fn('c.engine.never_implemented')?.file).toBe('c/engine.h');
    expect(raw('c.main.main', 'never_implemented')?.calleeId).toBe('c.engine.never_implemented');
  });

  it('sends a libc call into boundary because no scanned file declares it', () => {
    const e = raw('c.main.main', 'printf');
    expect(e?.callType).toBe('boundary');
    expect(e?.calleeId).toBe('boundary:printf');
  });

  it('records a C struct without inventing methods for it', () => {
    expect(analysis.functions.every((f) => f.className === null)).toBe(true);
  });
});

describe('a type name two files declare in the same namespace', () => {
  /**
   * `namespace detail` is re-opened in every file that wants a private helper —
   * ordinary, idiomatic C++. Two files each declaring `detail::Impl` therefore
   * declare two UNRELATED types, and the shared scoped index used to award the
   * name to whichever file was scanned first. A THIRD file referring to
   * `detail::Impl` then resolved to that one and shipped a real
   * `internal_method` edge, with `dropped-calls.json` empty — invariant 2's
   * exact prohibition.
   *
   * The third file is the whole point. Inside `alpha.cpp` the reference is NOT
   * ambiguous: that translation unit declares its own `detail::Impl` and
   * resolving to it is correct. Only a caller that declares neither has to
   * choose, and that is the call that must be refused.
   *
   * Real source in a temp dir, because the question is what tree-sitter and the
   * two-pass resolver actually do with it.
   */
  const body = `namespace detail {
class Impl {
public:
  void run();
};
void Impl::run() {}
}
`;
  let analysis: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(
      {
        'src/alpha.cpp': body,
        'src/beta.cpp': body,
        'src/gamma.cpp': `namespace gamma {
void go(detail::Impl& impl) {
  impl.run();
}
}
`,
      },
      'cpp-ambiguous-',
    );
    const adapter = new CppAdapter();
    analysis = await adapter.analyze(adapter.discover(root), root);
  });

  const fromGamma = (): ModuleAnalysis['edges'] => analysis.edges.filter((e) => /gamma/.test(e.callerId));

  it('does not invent an edge from the file that declares neither', () => {
    const resolved = fromGamma().filter((e) => e.callType !== 'unresolved' && /run/.test(e.calleeId));
    expect(resolved).toEqual([]);
  });

  it('quarantines that call as unresolved, so the ambiguity is visible downstream', () => {
    // Refusing silently would be its own failure: `dropped-calls.json` is how a
    // reader learns the analyzer could not choose, rather than assuming the
    // call does not exist.
    expect(fromGamma().some((e) => e.callType === 'unresolved' && /run/.test(e.raw ?? ''))).toBe(true);
  });

  it('still records both definitions as real functions', () => {
    // Only the EDGE is refused. Both `Impl::run` bodies were parsed and both
    // are facts; dropping them would trade one invariant violation for another.
    expect(analysis.functions.filter((f) => f.name === 'run')).toHaveLength(2);
  });
});

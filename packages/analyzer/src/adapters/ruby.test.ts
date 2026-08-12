import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbooks/core';
import { RubyAdapter } from './ruby.js';

function writeRepo(files: Record<string, string>, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, source] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

const RUBY_FILES: Record<string, string> = {
  'lib/engine.rb': `module Motor
  class Engine
    attr_reader :rpm

    def initialize
      @rpm = 0
    end

    def spin
      @rpm += 1
      @rpm
    end
  end

  module Diagnostics
    def describe
      "engine"
    end
  end

  module Registry
    def registry_size
      0
    end
  end
end
`,
  'lib/helpers.rb': `def shout(text)
  text
end
`,
  'app/invoice.rb': `require 'json'
require_relative '../lib/engine'
require_relative '../lib/helpers'

module Billing
  class Base
    def audit
      @audited = true
    end
  end

  class Invoice < Base
    include Motor::Diagnostics
    extend Motor::Registry

    attr_accessor :total
    attr_reader :engine

    def initialize(engine)
      @engine = engine
      @total = 0
      @cfg = Motor::Engine.new
    end

    def self.build
      new(Motor::Engine.new)
    end

    class << self
      def from_json(text)
        JSON.parse(text)
      end
    end

    def audit
      super
      @audited = false
    end

    def compute
      @total += 1
      self.recalc
      recalc
      audit
      describe
      @engine.spin
      @cfg.spin
      local = Motor::Engine.new
      local.spin
      Invoice.build
      widget = Widget.new
      widget.poke
      [1, 2].each do |n|
        @total += n
        recalc
      end
      shout("done")
      send(:mystery)
      puts "totals"
      self.total = 5
      mystery.poke
    end

    def recalc
      @total = 0
    end
  end
end

module Shipping
  class Invoice
    def compute
      "shipping"
    end
  end
end

class Dispatcher
  def bill
    inv = Billing::Invoice.new(nil)
    inv.compute
  end

  def ship
    inv = Shipping::Invoice.new
    inv.compute
  end

  def meta
    Billing::Invoice.from_json("{}")
    Billing::Invoice.registry_size
  end
end
`,
  // Unparseable on purpose: it must not take its neighbours down.
  'app/broken.rb': `class Broken
  def m(
    @x =
end
`,
  // Discovery must not see any of these.
  'tmp/generated.rb': `def ghost; end
`,
  '.bundle/vendored.rb': `def vendored; end
`,
  'vendor/gem.rb': `def gemmed; end
`,
};

const RUBY_ANALYZED = ['app/broken.rb', 'app/invoice.rb', 'lib/engine.rb', 'lib/helpers.rb'];

describe('RubyAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new RubyAdapter();

  beforeAll(async () => {
    root = writeRepo(RUBY_FILES, 'hb-ruby-');
    analysis = await adapter.analyze(RUBY_ANALYZED, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  /** Call sites are identified by their source text, which is unique per fixture. */
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers Ruby sources but not bundler, Rails tmp or vendored trees', () => {
    const files = adapter.discover(root);
    expect(files).toContain('app/invoice.rb');
    expect(files).toContain('lib/engine.rb');
    expect(files).not.toContain('tmp/generated.rb');
    expect(files).not.toContain('.bundle/vendored.rb');
    expect(files).not.toContain('vendor/gem.rb');
  });

  it('puts the module nesting in the qualname, per <moduleId>.<qualname>', () => {
    expect(fn('lib.engine.Motor.Engine.spin')?.qualname).toBe('Motor.Engine.spin');
    expect(fn('lib.engine.Motor.Engine.spin')?.className).toBe('Engine');
    expect(fn('lib.engine.Motor.Engine.spin')?.isMethod).toBe(true);
    expect(fn('lib.helpers.shout')?.qualname).toBe('shout');
    expect(fn('lib.helpers.shout')?.className).toBeNull();
  });

  it('resolves a same-file call written with and without an explicit self', () => {
    for (const text of ['self.recalc', 'recalc']) {
      const e = raw('app.invoice.Billing.Invoice.compute', text);
      expect(e?.callType, text).toBe('self_method');
      expect(e?.calleeId, text).toBe('app.invoice.Billing.Invoice.recalc');
    }
  });

  it('resolves a cross-file call through require_relative', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', 'shout');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('lib.helpers.shout');
  });

  it('keeps two same-named classes in different modules of ONE file apart', () => {
    expect(fn('app.invoice.Billing.Invoice.compute')).toBeDefined();
    expect(fn('app.invoice.Shipping.Invoice.compute')).toBeDefined();
    expect(analysis.functions.filter((f) => f.qualname.endsWith('Invoice.compute'))).toHaveLength(2);
    expect(raw('app.invoice.Dispatcher.bill', 'inv.compute')?.calleeId).toBe(
      'app.invoice.Billing.Invoice.compute',
    );
    expect(raw('app.invoice.Dispatcher.ship', 'inv.compute')?.calleeId).toBe(
      'app.invoice.Shipping.Invoice.compute',
    );
  });

  it('resolves a call through an @ivar whose class an assignment stated', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', '@cfg.spin');
    expect(e?.callType).toBe('self_attr_method');
    expect(e?.calleeId).toBe('lib.engine.Motor.Engine.spin');
  });

  it('leaves an @ivar assigned from an untyped parameter unresolved rather than guessing', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', '@engine.spin');
    expect(e?.callType).toBe('unresolved');
    expect(e?.calleeId).toBe('unresolved:@engine.spin');
  });

  it('resolves a local learned from X.new, and its method call', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', 'local.spin');
    expect(e?.callType).toBe('param_method');
    expect(e?.calleeId).toBe('lib.engine.Motor.Engine.spin');
  });

  it('turns Foo.new on a scanned class into internal_constructor at its initialize', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', 'Motor::Engine.new');
    expect(e?.callType).toBe('internal_constructor');
    expect(e?.calleeId).toBe('lib.engine.Motor.Engine.initialize');
  });

  it('sends a call into an unscanned gem to boundary', () => {
    expect(raw('app.invoice.Billing.Invoice.from_json', 'JSON.parse')?.callType).toBe('boundary');
    expect(raw('app.invoice.Billing.Invoice.from_json', 'JSON.parse')?.calleeId).toBe('boundary:JSON.parse');
    expect(raw('app.invoice.Billing.Invoice.compute', 'Widget.new')?.callType).toBe('boundary_constructor');
    expect(raw('app.invoice.Billing.Invoice.compute', 'Widget.new')?.calleeId).toBe('boundary:Widget');
    expect(raw('app.invoice.Billing.Invoice.compute', 'widget.poke')?.calleeId).toBe('boundary:Widget.poke');
    expect(raw('app.invoice.Billing.Invoice.compute', 'puts')?.calleeId).toBe('boundary:Kernel.puts');
  });

  it('resolves a method a mixin supplies, on the module that defines it', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', 'describe');
    expect(e?.callType).toBe('self_method');
    expect(e?.calleeId).toBe('lib.engine.Motor.Diagnostics.describe');
  });

  it('resolves a class-level method supplied by extend', () => {
    const e = raw('app.invoice.Dispatcher.meta', 'Billing::Invoice.registry_size');
    expect(e?.callType).toBe('internal_func');
    expect(e?.calleeId).toBe('lib.engine.Motor.Registry.registry_size');
  });

  it('records def self.x and class << self as class-level methods', () => {
    expect(fn('app.invoice.Billing.Invoice.build')?.isMethod).toBe(false);
    expect(fn('app.invoice.Billing.Invoice.build')?.className).toBe('Invoice');
    expect(fn('app.invoice.Billing.Invoice.build')?.signature).toBe('def self.build');
    expect(fn('app.invoice.Billing.Invoice.from_json')?.isMethod).toBe(false);
    expect(raw('app.invoice.Dispatcher.meta', 'Billing::Invoice.from_json')?.calleeId).toBe(
      'app.invoice.Billing.Invoice.from_json',
    );
  });

  it('resolves a class-level call and a bare new inside a singleton method', () => {
    expect(raw('app.invoice.Billing.Invoice.compute', 'Invoice.build')?.callType).toBe('internal_func');
    expect(raw('app.invoice.Billing.Invoice.compute', 'Invoice.build')?.calleeId).toBe(
      'app.invoice.Billing.Invoice.build',
    );
    expect(raw('app.invoice.Billing.Invoice.build', 'new')?.callType).toBe('internal_constructor');
    expect(raw('app.invoice.Billing.Invoice.build', 'new')?.calleeId).toBe(
      'app.invoice.Billing.Invoice.initialize',
    );
  });

  it('sends super to the ancestor definition, not to itself', () => {
    const e = raw('app.invoice.Billing.Invoice.audit', 'super');
    expect(e?.callType).toBe('self_method');
    expect(e?.calleeId).toBe('app.invoice.Billing.Base.audit');
  });

  it('tracks @ivar reads and writes, blocks included', () => {
    const compute = fn('app.invoice.Billing.Invoice.compute');
    expect(compute?.selfAttrsWritten).toEqual(['total']);
    expect(compute?.selfAttrsRead).toEqual(['cfg', 'engine', 'total']);
    expect(fn('app.invoice.Billing.Invoice.recalc')?.selfAttrsWritten).toEqual(['total']);
    expect(fn('app.invoice.Billing.Invoice.recalc')?.selfAttrsRead).toEqual([]);
    expect(fn('app.invoice.Billing.Invoice.initialize')?.selfAttrsWritten).toEqual([
      'cfg',
      'engine',
      'total',
    ]);
    expect(fn('lib.engine.Motor.Engine.spin')?.selfAttrsRead).toEqual(['rpm']);
    expect(fn('lib.engine.Motor.Engine.spin')?.selfAttrsWritten).toEqual(['rpm']);
  });

  it('attributes calls inside a do-block to the enclosing method, not to a new scope', () => {
    const inBlock = analysis.edges.filter(
      (e) => e.callerId === 'app.invoice.Billing.Invoice.compute' && e.raw === 'recalc',
    );
    // once at statement level, once inside the block — same caller both times.
    expect(inBlock).toHaveLength(2);
    expect(raw('app.invoice.Billing.Invoice.compute', '[1, 2].each')?.calleeId).toBe('boundary:Array.each');
  });

  it('leaves an ungroundable dynamic call unresolved instead of inventing a target', () => {
    const e = raw('app.invoice.Billing.Invoice.compute', 'send');
    expect(e?.callType).toBe('unresolved');
    expect(e?.calleeId).toBe('unresolved:send');
    expect(raw('app.invoice.Billing.Invoice.compute', 'mystery.poke')?.callType).toBe('unresolved');
  });

  it('gives attr_* accessors real nodes and resolves a setter onto them', () => {
    const total = fn('app.invoice.Billing.Invoice.total');
    expect(total?.signature).toBe('attr_accessor :total');
    expect(total?.selfAttrsRead).toEqual(['total']);
    expect(total?.selfAttrsWritten).toEqual(['total']);
    expect(fn('app.invoice.Billing.Invoice.engine')?.selfAttrsWritten).toEqual([]);
    const setter = raw('app.invoice.Billing.Invoice.compute', 'self.total=');
    expect(setter?.callType).toBe('self_method');
    expect(setter?.calleeId).toBe('app.invoice.Billing.Invoice.total');
  });

  it('skips a file that fails to parse without losing its neighbours', () => {
    expect(analysis.functions.filter((f) => f.file === 'app/broken.rb')).toEqual([]);
    expect(fn('app.invoice.Billing.Invoice.compute')).toBeDefined();
    expect(fn('lib.engine.Motor.Engine.spin')).toBeDefined();
  });

  it('declares exactly the callTypes the fixture produces, in both directions', () => {
    const produced = new Set<CallType>(analysis.edges.map((e) => e.callType));
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect([...declared].filter((t) => !produced.has(t)).sort()).toEqual([]);
    expect(adapter.capabilities.tier).toBe('full');
    expect(adapter.capabilities.selfAttrs).toBe(true);
    expect(adapter.capabilities.statementSpans).toBe(false);
    expect(adapter.statementSpans).toBeUndefined();
  });
});

/**
 * Clean fixtures hide real-world breakage — the C++ adapter's `extern "C"`
 * disaster was invisible to its tidy ones. So this tree is deliberately nasty:
 * heredocs (interpolating and not), `=begin` blocks, `__END__` data, `%i` with a
 * `define_method` loop, a multiline chain with an interior comment,
 * `rescue`/`else`/`ensure` inside a block, `class << self`, an operator `def`,
 * a refinement, `class_eval`, and a top-level `Item` colliding with `App::Item`.
 *
 * Measured before it was written: the `ruby` grammar parses every one of these
 * with `hasError=false` and its output does not depend on what the same parser
 * saw earlier. The assertions below therefore pin BOTH the parts that work and
 * the documented gaps, so a gap cannot start behaving differently in silence.
 */
const GNARLY_FILES: Record<string, string> = {
  'support.rb': `module Support
  class Record
    def query(sql)
      sql
    end
  end

  class NullLogger
    def warn(msg)
      msg
    end
  end

  class Missing < StandardError
  end
end

class Item
  def validate!
    false
  end
end
`,
  'gnarly.rb': `# frozen_string_literal: true
=begin
Block comment naming def fake_method and class Fake. Neither exists.
=end

require_relative 'support'

module App
  class Repo < Support::Record
    include Enumerable
    def_delegators :@items, :each, :size

    SQL = <<~SQL.freeze
      SELECT * FROM items WHERE id = #{'?'}
    SQL

    RAW = <<-'TEXT'
      no #{interpolation} here
    TEXT

    %i[alpha beta].each do |kind|
      define_method("fetch_#{kind}") { |arg| find(kind, arg) }
    end

    class << self
      attr_reader :registry

      def register(klass)
        (@registry ||= []) << klass
      end
    end

    def initialize(conn:)
      @conn = conn
      @logger = Support::NullLogger.new
      @cache = {}
    end

    def find(kind, id)
      @cache.fetch(id) do
        row = @conn
          .query(SQL)   # multiline chain with an interior comment
          .first
        build(row)
      rescue Support::Missing => e
        @logger.warn(e)
        nil
      ensure
        @logger.warn('done')
      end
    end

    def build(row)
      query(SQL)
      Item.new.tap { |i| i.validate! }
    end

    def <<(other)
      @cache = other
    end

    def method_missing(name, *args)
      send(name, *args)
    end
  end

  class Item
    def validate!
      true
    end
  end
end

module Sharpen
  refine String do
    def shout
      upcase
    end
  end
end

App::Repo.class_eval do
  def injected
    :hi
  end
end

__END__
def not_a_method; end
class NotAClass; end
`,
};

describe('RubyAdapter — hairy realistic Ruby', () => {
  let analysis: ModuleAnalysis;

  beforeAll(async () => {
    const root = writeRepo(GNARLY_FILES, 'hb-ruby-gnarly-');
    analysis = await new RubyAdapter().analyze(['gnarly.rb', 'support.rb'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const named = (name: string) => analysis.functions.filter((f) => f.name === name);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('keeps every definition that follows a heredoc, a %i loop and a singleton class', () => {
    for (const id of [
      'gnarly.App.Repo.initialize',
      'gnarly.App.Repo.find',
      'gnarly.App.Repo.build',
      'gnarly.App.Repo.method_missing',
      'gnarly.App.Repo.register',
      'gnarly.App.Item.validate!',
    ]) {
      expect(fn(id), id).toBeDefined();
    }
  });

  it('reads a multiline chain broken by an interior comment', () => {
    expect(raw('gnarly.App.Repo.find', '@conn.query')?.callType).toBe('unresolved');
    expect(raw('gnarly.App.Repo.find', 'build')?.calleeId).toBe('gnarly.App.Repo.build');
  });

  it('attributes calls in a block rescue/ensure to the enclosing method', () => {
    const warns = analysis.edges.filter(
      (e) => e.callerId === 'gnarly.App.Repo.find' && e.raw === '@logger.warn',
    );
    expect(warns).toHaveLength(2);
    expect(warns[0]?.callType).toBe('self_attr_method');
    expect(warns[0]?.calleeId).toBe('support.Support.NullLogger.warn');
    expect(fn('gnarly.App.Repo.find')?.selfAttrsRead).toEqual(['cache', 'conn', 'logger']);
  });

  it('prefers the lexically nearer Item over the top-level class of the same name', () => {
    expect(raw('gnarly.App.Repo.build', 'Item.new')?.callType).toBe('internal_constructor');
    expect(raw('gnarly.App.Repo.build', 'Item.new')?.calleeId).toBe('gnarly.App.Item.initialize');
    expect(
      named('validate!')
        .map((f) => f.id)
        .sort(),
    ).toEqual(['gnarly.App.Item.validate!', 'support.Item.validate!']);
  });

  it('makes class << self members class-level, reader included', () => {
    expect(fn('gnarly.App.Repo.registry')?.isMethod).toBe(false);
    expect(fn('gnarly.App.Repo.registry')?.selfAttrsWritten).toEqual([]);
    expect(fn('gnarly.App.Repo.register')?.isMethod).toBe(false);
    expect(fn('gnarly.App.Repo.register')?.selfAttrsRead).toEqual(['registry']);
    expect(fn('gnarly.App.Repo.register')?.selfAttrsWritten).toEqual(['registry']);
  });

  it('resolves an inherited method through a superclass declared in another file', () => {
    // `query` is Support::Record's; Repo reaches it only through `< Support::Record`.
    const e = raw('gnarly.App.Repo.build', 'query');
    expect(e?.callType).toBe('self_method');
    expect(e?.calleeId).toBe('support.Support.Record.query');
    expect(analysis.functions.some((f) => f.id === 'gnarly.App.Repo.query')).toBe(false);
  });

  it('ignores comment blocks and __END__ data instead of mining them for code', () => {
    expect(named('fake_method')).toEqual([]);
    expect(named('not_a_method')).toEqual([]);
    expect(analysis.functions.some((f) => f.className === 'NotAClass')).toBe(false);
  });

  it('records the documented metaprogramming gaps as gaps, not as invented nodes', () => {
    // define_method / class_eval / refine bodies define methods at run time.
    expect(named('fetch_alpha')).toEqual([]);
    expect(named('injected')).toEqual([]);
    expect(named('shout')).toEqual([]);
    // def_delegators mints `each`/`size`; nothing is expanded for it.
    expect(named('size')).toEqual([]);
    // An operator definition gets no node, so its `=` name never reaches an id.
    expect(named('<<')).toEqual([]);
    expect(analysis.functions.every((f) => /^[\w.!?=]+$/.test(f.id))).toBe(true);
    // `send` is never followed to its symbol argument.
    expect(raw('gnarly.App.Repo.method_missing', 'send')?.callType).toBe('unresolved');
  });

  it('produces a non-empty graph from the whole nasty tree', () => {
    expect(analysis.functions.length).toBeGreaterThan(8);
    expect(analysis.edges.length).toBeGreaterThan(8);
    expect(analysis.functions.every((f) => f.lineStart > 0 && f.lineEnd >= f.lineStart)).toBe(true);
  });
});

describe('RubyAdapter — parsed type declarations', () => {
  let analysis: ModuleAnalysis;
  const SRC = `module Demo
  class Engine
    def spin
      @rpm = 1
    end
  end

  class Sub < Engine; end

  class Bare
  end

  module Loggable
    def log(m); m; end
  end

  Alias = Engine

  class << self
    def meta; 1; end
  end
end

class Demo::Nested
  def deep; 1; end
end
`;
  const lines = SRC.split('\n');
  const find = (name: string): NonNullable<ModuleAnalysis['types']>[number] | undefined =>
    (analysis.types ?? []).find((t) => t.name === name);

  beforeAll(async () => {
    const root = writeRepo({ 'lib/kinds.rb': SRC }, 'hb-ruby-types-');
    analysis = await new RubyAdapter().analyze(['lib/kinds.rb'], root);
  });

  it('calls a class a class', () => {
    expect(find('Engine')?.kind).toBe('class');
    expect(find('Sub')?.kind).toBe('class');
  });

  it('files a module under `other` rather than guessing which job it does', () => {
    // One keyword, two unrelated jobs: `module Demo` is a namespace, `module
    // Loggable` is a mixin carrying implementation. Nothing in either declaration
    // says which, so both stay `other` and the signature carries the keyword.
    expect(find('Demo')?.kind).toBe('other');
    expect(find('Loggable')?.kind).toBe('other');
    expect(find('Demo')?.signature).toBe('module Demo');
    expect(find('Loggable')?.signature).toBe('module Loggable');
  });

  it('spans the declaration from its keyword to its `end`', () => {
    const engine = find('Engine');
    expect(lines[(engine?.lineStart ?? 0) - 1]).toContain('class Engine');
    expect(lines[(engine?.lineEnd ?? 0) - 1]?.trim()).toBe('end');
    expect(engine?.lineEnd).toBeGreaterThan(engine?.lineStart ?? 0);
  });

  it('stops a body-less declaration signature at `end`, not after it', () => {
    // An empty class has no body node at all, so without the `end` stop the header
    // would read "class Bare end" — a keyword the reader never wrote in a header.
    expect(find('Bare')?.signature).toBe('class Bare');
    // The one-line form keeps its statement separator, exactly as written: the
    // signature is the declaration verbatim, not a re-rendering of it.
    expect(find('Sub')?.signature).toBe('class Sub < Engine;');
  });

  it('nests a type under the module it is written in', () => {
    expect(find('Engine')?.qualname).toBe('Demo.Engine');
    expect(find('Engine')?.container).toBe('Demo');
    expect(find('Engine')?.id).toBe('type:lib.kinds.Demo.Engine');
    expect(find('Demo')?.container).toBeNull();
  });

  it('nests a compound-name declaration under the scope it names', () => {
    // `class Demo::Nested` does not open `Demo` as a lookup scope, but it is still
    // written inside it, and the qualname must match what the methods got.
    expect(find('Nested')?.qualname).toBe('Demo.Nested');
    expect(find('Nested')?.container).toBe('Demo');
    expect(analysis.functions.find((f) => f.name === 'deep')?.qualname).toBe('Demo.Nested.deep');
  });

  it('emits nothing for `class << self` or for a constant assignment', () => {
    // The singleton class declares no new type and has no name; `Alias = Engine`
    // is an expression evaluated at load time, not a declaration.
    expect((analysis.types ?? []).map((t) => t.name).sort()).toEqual([
      'Bare',
      'Demo',
      'Engine',
      'Loggable',
      'Nested',
      'Sub',
    ]);
  });

  it('declares exactly the kinds it emits', () => {
    expect(new RubyAdapter().capabilities.typeKinds).toEqual(['class', 'other']);
  });
});

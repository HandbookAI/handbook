import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbook/core';
import { PhpAdapter } from './php.js';

/** The type the app file leans on, plus a free function in the same namespace. */
const ENGINE_PHP = `<?php

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
`;

/** An abstract ancestor and an interface, both in the app's own namespace. */
const BASE_PHP = `<?php

namespace App\\Billing;

interface Payable
{
    public function pay(): int;
}

abstract class Base implements Payable
{
    protected int $cycles = 0;

    public function reset(): void
    {
        $this->cycles = 0;
    }

    abstract public function label(): string;
}
`;

/** A trait and a namespaced free function reached through \`use function\`. */
const SUPPORT_PHP = `<?php

namespace App\\Support;

trait Loggable
{
    public function log(string $line): string
    {
        return strtoupper($line);
    }
}

function shout(string $text): string
{
    return $text;
}
`;

/**
 * The scoped-index case: two classes with the SAME name in DIFFERENT namespaces
 * in ONE file. A bare-name type table keeps whichever it met first and would
 * send \`Beta\\Runner\`'s call to \`Alpha\\Config\`.
 */
const SCOPES_PHP = `<?php

namespace Alpha {
    class Config
    {
        public function load(): int
        {
            return 1;
        }
    }
}

namespace Beta {
    class Config
    {
        public function load(): int
        {
            return 2;
        }
    }

    class Runner
    {
        private Config $config;

        public function run(): int
        {
            return $this->config->load();
        }
    }
}
`;

/**
 * Note what is deliberately absent: no \`use\` names App\\Billing, because
 * Ledger.php already lives in it — PHP resolves same-namespace types without one.
 */
const LEDGER_PHP = `<?php

namespace App\\Billing;

use App\\Engine\\Engine;
use App\\Engine\\Engine as Motor;
use App\\Support\\Loggable;
use function App\\Support\\shout;
use Vendor\\Widget;

#[Table('ledgers')]
class Ledger extends Base
{
    use Loggable;

    private Engine $engine;
    protected ?Widget $widget = null;
    public int $hits = 0;

    public function __construct(Engine $engine)
    {
        $this->engine = $engine;
        $this->hits = 0;
    }

    #[Route('/post')]
    public function post(Motor $motor, string $label): bool
    {
        $this->prepare();
        $this->engine->spin();
        $motor->spin();
        $this->widget->poke();
        $made = new Engine();
        $made->spin();
        $extra = new Widget();
        $extra->poke();
        Engine::describe();
        \\App\\Engine\\ignite($made);
        shout($label);
        self::helper();
        parent::reset();
        $this->log($label);
        \\strlen($label);
        mystery();
        $method = 'spin';
        $made->$method();
        $this->hits += 1;
        return $this->hits > 0;
    }

    public function label(): string
    {
        return 'ledger';
    }

    private function prepare(): void
    {
        $this->hits = 0;
    }

    public static function helper(): void
    {
    }
}
`;

/** Mixed HTML and PHP with a group \`use\` — the shape half of real PHP has. */
const LIST_PHP = `<h1>Rows</h1>
<?php

namespace App\\View;

use App\\Engine\\{Engine};

class ListView
{
    private Engine $engine;

    public function render(Engine $other): void
    {
        $this->engine->spin();
        ?>
        <ul><li><?= $other->spin() ?></li></ul>
        <?php
        $other?->spin();
    }
}
`;

/** Not PHP at all: must be skipped without taking its neighbours down. */
const BROKEN_PHP = `<?php
%%% not php {{{ ??? ]]]
class }}} <<< &&&
++ ++ ++
`;

/** A .php file with no PHP in it: legal, and contributes nothing. */
const PAGE_PHP = `<!DOCTYPE html>
<html>
  <body><h1>Static page</h1></body>
</html>
`;

/** A .phtml file whose base class is outside the scan set. */
const REPORT_PHTML = `<?php

namespace Legacy;

use Vendor\\Kernel;

class Report extends Kernel
{
    public function render(): string
    {
        parent::boot();
        return 'report';
    }
}
`;

/**
 * Two SEQUENTIAL unbraced namespaces in one file, each binding the same local
 * alias to a different class. A per-file import table answers the first one
 * for both — measured on real-shaped input, not imagined.
 */
const ALIASES_PHP = `<?php

namespace Shop\\First;

use App\\Engine\\Engine as Tool;

class Alpha
{
    public function go(Tool $tool): int
    {
        return $tool->spin();
    }
}

namespace Shop\\Second;

use Vendor\\Gadget as Tool;

class Beta
{
    public function go(Tool $tool): void
    {
        $tool->spin();
    }
}
`;

const FILES: Record<string, string> = {
  'src/Engine.php': ENGINE_PHP,
  'src/Base.php': BASE_PHP,
  'src/Support.php': SUPPORT_PHP,
  'src/Scopes.php': SCOPES_PHP,
  'src/Aliases.php': ALIASES_PHP,
  'src/Ledger.php': LEDGER_PHP,
  'src/Broken.php': BROKEN_PHP,
  'templates/list.php': LIST_PHP,
  'templates/page.php': PAGE_PHP,
  'legacy/Report.phtml': REPORT_PHTML,
  'resources/views/rows.blade.php': "@extends('layout')\n@section('body'){{ $x }}@endsection\n",
  'vendor/acme/lib/Ignored.php': '<?php\nclass Ignored { public function nope() {} }\n',
};

const ANALYZED = [
  'src/Engine.php',
  'src/Base.php',
  'src/Support.php',
  'src/Scopes.php',
  'src/Aliases.php',
  'src/Ledger.php',
  'src/Broken.php',
  'templates/list.php',
  'templates/page.php',
  'legacy/Report.phtml',
];

const POST = 'src.Ledger.App.Billing.Ledger.post';
const SPIN = 'src.Engine.App.Engine.Engine.spin';

describe('PhpAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new PhpAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-php-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    analysis = await adapter.analyze(ANALYZED, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
  const raw = (caller: string, text: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.raw === text);

  it('discovers .php and .phtml, skipping vendor/ and Blade templates', () => {
    const files = adapter.discover(root);
    expect(files).toContain('src/Ledger.php');
    expect(files).toContain('templates/page.php');
    expect(files).toContain('legacy/Report.phtml');
    expect(files).not.toContain('resources/views/rows.blade.php');
    expect(files).not.toContain('vendor/acme/lib/Ignored.php');
  });

  it('derives module ids from the path and keeps the namespace in the qualname', () => {
    expect(fn(SPIN)?.qualname).toBe('App.Engine.Engine.spin');
    expect(fn('src.Ledger.App.Billing.Ledger.post')?.qualname).toBe('App.Billing.Ledger.post');
    expect(fn('src.Support.App.Support.shout')?.qualname).toBe('App.Support.shout');
    expect(fn('legacy.Report.Legacy.Report.render')).toBeDefined();
  });

  it('extracts methods, constructors, static methods and free functions', () => {
    expect(fn(POST)?.isMethod).toBe(true);
    expect(fn(POST)?.className).toBe('Ledger');
    expect(fn('src.Engine.App.Engine.Engine.__construct')?.className).toBe('Engine');
    // A static method belongs to the class but has no receiver.
    expect(fn('src.Engine.App.Engine.Engine.describe')?.isMethod).toBe(false);
    expect(fn('src.Engine.App.Engine.Engine.describe')?.className).toBe('Engine');
    expect(fn('src.Engine.App.Engine.ignite')?.isMethod).toBe(false);
    expect(fn('src.Engine.App.Engine.ignite')?.className).toBeNull();
  });

  it('records bodiless interface and abstract declarations so edges never dangle', () => {
    expect(fn('src.Base.App.Billing.Payable.pay')).toBeDefined();
    expect(fn('src.Base.App.Billing.Base.label')).toBeDefined();
  });

  it('gives a single-line signature without the attribute prefix', () => {
    expect(fn(POST)?.signature).toBe('public function post(Motor $motor, string $label): bool');
    expect(fn('src.Base.App.Billing.Base.label')?.signature).toBe('abstract public function label(): string');
  });

  it('captures PHP 8 attributes as decorators', () => {
    expect(fn(POST)?.decorators).toEqual(['Route']);
    expect(fn('src.Ledger.App.Billing.Ledger.prepare')?.decorators).toEqual([]);
  });

  it('learns declared parameter types and drops primitive ones', () => {
    expect(fn(POST)?.paramTypes).toEqual({ motor: 'Motor' });
    expect(fn('src.Engine.App.Engine.ignite')?.paramTypes).toEqual({ e: 'Engine' });
    expect(fn('src.Support.App.Support.shout')?.paramTypes).toEqual({});
  });

  it('never claims async, which PHP does not have', () => {
    expect(analysis.functions.every((f) => !f.isAsync)).toBe(true);
    expect(analysis.edges.every((e) => !e.isAwait)).toBe(true);
  });

  it('tracks $this-> property reads and writes', () => {
    expect(fn(POST)?.selfAttrsWritten).toEqual(['hits']);
    expect(fn(POST)?.selfAttrsRead).toEqual(['engine', 'hits', 'widget']);
    expect(fn('src.Ledger.App.Billing.Ledger.__construct')?.selfAttrsWritten).toEqual(['engine', 'hits']);
    const spin = fn(SPIN);
    expect(spin?.selfAttrsWritten).toEqual(['rpm']);
    expect(spin?.selfAttrsRead).toEqual(['rpm']);
  });

  it('does not mistake a called method name for a state attribute', () => {
    expect(fn(POST)?.selfAttrsRead).not.toContain('prepare');
    expect(fn(POST)?.selfAttrsRead).not.toContain('log');
  });

  it('resolves $this->m() in the same file to self_method', () => {
    expect(edge(POST, 'src.Ledger.App.Billing.Ledger.prepare')?.callType).toBe('self_method');
  });

  it('resolves self::m() on the caller own class', () => {
    expect(edge(POST, 'src.Ledger.App.Billing.Ledger.helper')?.callType).toBe('self_method');
  });

  it('resolves parent::m() into the scanned ancestor that declares it', () => {
    const e = raw(POST, 'parent::reset');
    expect(e?.calleeId).toBe('src.Base.App.Billing.Base.reset');
    expect(e?.callType).toBe('self_method');
  });

  it('sends parent::m() to a boundary when the base class is not scanned', () => {
    const e = raw('legacy.Report.Legacy.Report.render', 'parent::boot');
    expect(e?.calleeId).toBe('boundary:Vendor.Kernel.boot');
    expect(e?.callType).toBe('boundary');
  });

  it('resolves a trait method used by the class', () => {
    const e = raw(POST, '$this->log');
    expect(e?.calleeId).toBe('src.Support.App.Support.Loggable.log');
    expect(e?.callType).toBe('self_method');
  });

  it('resolves $this->field->m() through the typed property', () => {
    const e = raw(POST, '$this->engine->spin');
    expect(e?.calleeId).toBe(SPIN);
    expect(e?.callType).toBe('self_attr_method');
  });

  it('resolves $param->m() through the declared parameter type, alias included', () => {
    const e = raw(POST, '$motor->spin');
    expect(e?.calleeId).toBe(SPIN);
    expect(e?.callType).toBe('param_method');
  });

  it('resolves a local assigned from new against the created type', () => {
    const e = raw(POST, '$made->spin');
    expect(e?.calleeId).toBe(SPIN);
    expect(e?.callType).toBe('param_method');
  });

  it('resolves a static call on a scanned type to the real member', () => {
    const e = raw(POST, 'Engine::describe');
    expect(e?.calleeId).toBe('src.Engine.App.Engine.Engine.describe');
    expect(e?.callType).toBe('internal_func');
  });

  it('resolves a namespace-qualified free function call', () => {
    const e = raw(POST, '\\App\\Engine\\ignite');
    expect(e?.calleeId).toBe('src.Engine.App.Engine.ignite');
    expect(e?.callType).toBe('internal_func');
  });

  it('resolves a cross-file call made visible by use function', () => {
    const e = raw(POST, 'shout');
    expect(e?.calleeId).toBe('src.Support.App.Support.shout');
    expect(e?.callType).toBe('internal_func');
  });

  it('resolves new on a scanned type to its __construct', () => {
    const e = raw(POST, 'new Engine()');
    expect(e?.calleeId).toBe('src.Engine.App.Engine.Engine.__construct');
    expect(e?.callType).toBe('internal_constructor');
  });

  it('sends new on an unscanned type to a boundary, qualified by its use import', () => {
    const e = raw(POST, 'new Widget()');
    expect(e?.calleeId).toBe('boundary:Vendor.Widget');
    expect(e?.callType).toBe('boundary_constructor');
  });

  it('peels a nullable property type and sends unscanned types to boundary', () => {
    const e = raw(POST, '$this->widget->poke');
    expect(e?.calleeId).toBe('boundary:Vendor.Widget.poke');
    expect(e?.callType).toBe('boundary');
  });

  it('sends a bare call no scanned file declares to a boundary', () => {
    expect(edge(POST, 'boundary:mystery')?.callType).toBe('boundary');
    expect(edge(POST, 'boundary:strlen')?.callType).toBe('boundary');
    expect(edge('src.Support.App.Support.Loggable.log', 'boundary:strtoupper')?.callType).toBe('boundary');
  });

  it('leaves an ungroundable dynamic call unresolved rather than guessing', () => {
    const e = analysis.edges.find((x) => x.callerId === POST && x.callType === 'unresolved');
    expect(e?.calleeId).toBe('unresolved:$made->$method');
  });

  it('resolves $param->m() from a free function too', () => {
    const e = edge('src.Engine.App.Engine.ignite', SPIN);
    expect(e?.callType).toBe('param_method');
  });

  it('keeps two same-named classes in different namespaces of ONE file apart', () => {
    expect(fn('src.Scopes.Alpha.Config.load')).toBeDefined();
    expect(fn('src.Scopes.Beta.Config.load')).toBeDefined();
    const e = edge('src.Scopes.Beta.Runner.run', 'src.Scopes.Beta.Config.load');
    expect(e?.callType).toBe('self_attr_method');
    expect(edge('src.Scopes.Beta.Runner.run', 'src.Scopes.Alpha.Config.load')).toBeUndefined();
  });

  it('binds a use alias per namespace block, not per file', () => {
    const first = edge('src.Aliases.Shop.First.Alpha.go', SPIN);
    expect(first?.callType).toBe('param_method');
    const second = edge('src.Aliases.Shop.Second.Beta.go', 'boundary:Vendor.Gadget.spin');
    expect(second?.callType).toBe('boundary');
  });

  it('keeps resolving across a ?> … <?php gap in a mixed HTML file', () => {
    const render = 'templates.list.App.View.ListView.render';
    expect(fn(render)).toBeDefined();
    expect(edge(render, SPIN)?.callType).toBeDefined();
    // Three calls to spin(): one through the property, one inside the markup,
    // one after the closing tag — and the group `use` grounded the type.
    const spins = analysis.edges.filter((e) => e.callerId === render && e.calleeId === SPIN);
    expect(spins).toHaveLength(3);
    expect(spins.map((e) => e.callType).sort()).toEqual(['param_method', 'param_method', 'self_attr_method']);
  });

  it('skips an unparseable file without taking its neighbours down', () => {
    expect(analysis.functions.some((f) => f.file === 'src/Broken.php')).toBe(false);
    expect(analysis.functions.some((f) => f.file === 'src/Ledger.php')).toBe(true);
  });

  it('contributes nothing for a .php file that contains no PHP', () => {
    expect(analysis.functions.some((f) => f.file === 'templates/page.php')).toBe(false);
  });

  it('reports line spans that bracket each declaration', () => {
    const post = fn(POST);
    expect(post?.lineStart).toBeGreaterThan(0);
    expect(post?.lineEnd).toBeGreaterThan(post?.lineStart ?? 0);
    expect(post?.file).toBe('src/Ledger.php');
  });

  it('declares exactly the callTypes the fixture produces, in both directions', () => {
    const produced = new Set<CallType>(analysis.edges.map((e) => e.callType));
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect([...declared].filter((t) => !produced.has(t)).sort()).toEqual([]);
  });

  it('declares full tier with selfAttrs and no statement spans', () => {
    expect(adapter.capabilities.tier).toBe('full');
    expect(adapter.capabilities.selfAttrs).toBe(true);
    expect(adapter.capabilities.statementSpans).toBe(false);
    expect(adapter.statementSpans).toBeUndefined();
  });
});

describe('PhpAdapter — parsed type declarations', () => {
  let analysis: ModuleAnalysis;
  const SRC = `<?php

namespace App\\Demo;

class Engine
{
    public function spin(): void {}
}

abstract class Base {}

interface Spinner
{
    public function spin(): void;
}

trait Loggable
{
    public function log(): void {}
}

enum Gear
{
    case Low;
    case High;
}

enum Suit: string
{
    case Hearts = 'H';
}

$anon = new class extends Base {};
`;
  const lines = SRC.split('\n');
  const find = (name: string): NonNullable<ModuleAnalysis['types']>[number] | undefined =>
    (analysis.types ?? []).find((t) => t.name === name);

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-php-types-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'Kinds.php'), SRC);
    analysis = await new PhpAdapter().analyze(['src/Kinds.php'], root);
  });

  it('maps each of PHP four declaration keywords onto its own bucket', () => {
    expect(find('Engine')?.kind).toBe('class');
    expect(find('Spinner')?.kind).toBe('interface');
    expect(find('Loggable')?.kind).toBe('trait');
    expect(find('Gear')?.kind).toBe('enum');
  });

  it('keeps the modifier in the signature rather than inventing a kind for it', () => {
    expect(find('Base')?.kind).toBe('class');
    expect(find('Base')?.signature).toBe('abstract class Base');
  });

  it('keeps a backed enum an enum, with its backing type in the signature', () => {
    expect(find('Suit')?.kind).toBe('enum');
    expect(find('Suit')?.signature).toBe('enum Suit: string');
  });

  it('spans the declaration, not its members', () => {
    const engine = find('Engine');
    // `class Engine` on its own line and the body brace on the next: the span must
    // start at the keyword, which is the whole reason this is parsed and not derived.
    expect(lines[(engine?.lineStart ?? 0) - 1]).toBe('class Engine');
    expect(engine?.lineEnd).toBeGreaterThan(engine?.lineStart ?? 0);
    expect(lines[(engine?.lineEnd ?? 0) - 1]).toBe('}');
  });

  it('keeps the namespace in the qualname and leaves container null', () => {
    // A namespace is a scope, not a type — and PHP has no nested type declarations,
    // so `container` is null for every row this adapter can ever emit.
    expect(find('Engine')?.qualname).toBe('App.Demo.Engine');
    expect(find('Engine')?.id).toBe('type:src.Kinds.App.Demo.Engine');
    expect(find('Engine')?.container).toBeNull();
    expect((analysis.types ?? []).every((t) => t.container === null)).toBe(true);
  });

  it('emits a row for every named declaration in the file and nothing else', () => {
    // The fixture's last line is `new class extends Base {}`. It contributes no row,
    // and the reason is structural rather than a name check: the grammar makes an
    // anonymous class an `object_creation_expression` inside an expression statement,
    // which is not a declaration container, so it is never even a candidate. Pinned
    // here because "no row" and "no name" would otherwise look like the same fact.
    expect((analysis.types ?? []).map((t) => t.name).sort()).toEqual([
      'Base',
      'Engine',
      'Gear',
      'Loggable',
      'Spinner',
      'Suit',
    ]);
  });

  it('declares exactly the four kinds it emits', () => {
    expect(new PhpAdapter().capabilities.typeKinds).toEqual(['class', 'enum', 'interface', 'trait']);
  });
});

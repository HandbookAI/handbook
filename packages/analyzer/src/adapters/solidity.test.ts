import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbook/core';
import { SolidityAdapter } from './solidity.js';

/**
 * Deliberately hairy: NatSpec (line and block), `pragma abicoder`, an assembly
 * block, a `try`/`catch`, `unchecked`, arrays and mappings of contract types.
 * Clean fixtures hide real-world breakage, so the fixture is not clean.
 */
const ENGINE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
pragma abicoder v2;

/**
 * @title EngineBase
 * @notice Block NatSpec above an abstract contract.
 */
abstract contract EngineBase {
    uint256 internal cycles;

    function reset() internal virtual {
        cycles = 0;
    }
}

contract Engine is EngineBase {
    uint256 public rpm;
    address private keeper;

    event Spun(uint256 rpm);

    constructor(uint256 initial) {
        rpm = initial;
        keeper = msg.sender;
    }

    /// @notice Bump the counter.
    /// @return the new value
    function spin() public returns (uint256) {
        rpm = rpm + 1;
        emit Spun(rpm);
        assembly {
            let slot := mload(0x40)
            sstore(0, slot)
        }
        return rpm;
    }
}
`;

const IVAULT_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVault {
    event Deposited(address who);

    function deposit(uint256 amount) external;
}
`;

const MATH_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library MathLib {
    function double(uint256 a) internal pure returns (uint256) {
        return a * 2;
    }
}

function shout(uint256 a) pure returns (uint256) {
    return a;
}
`;

const APP_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Engine, EngineBase} from "./Engine.sol";
import {MathLib, shout} from "./MathLib.sol";
import "./IVault.sol";
import {IERC20 as Token} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Widget} from "./vendor/Widget.sol";

/// @title App
/// @notice A line-NatSpec header with @tags.
contract App is EngineBase {
    Engine public engine;
    IVault public vault;
    address public owner;
    uint256 public total;
    mapping(address => Engine) public fleet;

    event Started(address who);

    error NotOwner(address who);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(Engine e) {
        engine = e;
        owner = msg.sender;
    }

    receive() external payable {}

    function run(Engine other, uint256 amount) external onlyOwner returns (uint256) {
        prepare();
        reset();
        this.prepare();
        engine.spin();
        other.spin();
        vault.deposit(amount);
        fleet[msg.sender].spin();
        total = MathLib.double(total);
        total += shout(amount);
        Engine made = new Engine(1);
        made.spin();
        Token(owner).transfer(owner, amount);
        Widget w = new Widget();
        owner.call{value: amount}("");
        unchecked {
            total = total + 1;
        }
        try vault.deposit(1) returns (bool) {
            total = 0;
        } catch {
            total = 1;
        }
        mystery();
        emit Started(owner);
        return total;
    }

    function prepare() public {
        cycles = cycles + 1;
        total = 0;
    }
}
`;

/** Not parseable: the adapter must contribute nothing for it and not throw. */
const BROKEN_SOL = `contract Broken {
    function f( {
        unclosed
`;

const FILES: Record<string, string> = {
  'src/Engine.sol': ENGINE_SOL,
  'src/IVault.sol': IVAULT_SOL,
  'src/MathLib.sol': MATH_SOL,
  'src/App.sol': APP_SOL,
  'src/Broken.sol': BROKEN_SOL,
};

const ANALYZE = ['src/App.sol', 'src/Engine.sol', 'src/IVault.sol', 'src/MathLib.sol', 'src/Broken.sol'];

describe('SolidityAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new SolidityAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-sol-'));
    for (const [rel, source] of Object.entries(FILES)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source);
    }
    analysis = await adapter.analyze(ANALYZE, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);
  const edgesFrom = (caller: string) => analysis.edges.filter((e) => e.callerId === caller);

  it('discovers .sol files and skips build output', () => {
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'artifacts', 'Ignored.sol'), 'contract Ignored {}');
    const files = adapter.discover(root);
    expect(files).toContain('src/App.sol');
    expect(files).toContain('src/Engine.sol');
    expect(files).not.toContain('artifacts/Ignored.sol');
  });

  it('records contracts, interfaces, libraries and abstract contracts as owners', () => {
    expect(fn('src.App.App.run')?.className).toBe('App');
    expect(fn('src.Engine.EngineBase.reset')?.className).toBe('EngineBase');
    expect(fn('src.IVault.IVault.deposit')?.className).toBe('IVault');
    expect(fn('src.MathLib.MathLib.double')?.className).toBe('MathLib');
  });

  it('uses <module>.<Contract>.<member> ids with a <Contract>.<member> qualname', () => {
    const run = fn('src.App.App.run');
    expect(run?.qualname).toBe('App.run');
    expect(run?.name).toBe('run');
    expect(run?.isMethod).toBe(true);
    expect(run?.file).toBe('src/App.sol');
  });

  it('records a constructor under the contract name, so new C() has a target', () => {
    const ctor = fn('src.Engine.Engine.Engine');
    expect(ctor).toBeDefined();
    expect(ctor?.qualname).toBe('Engine.Engine');
  });

  it('records modifiers, receive and body-less interface declarations as functions', () => {
    expect(fn('src.App.App.onlyOwner')).toBeDefined();
    expect(fn('src.App.App.receive')).toBeDefined();
    // Declared in an interface, so no body — but it is what an external call hits.
    expect(fn('src.IVault.IVault.deposit')).toBeDefined();
  });

  it('records file-level free functions without a class', () => {
    const free = fn('src.MathLib.shout');
    expect(free).toBeDefined();
    expect(free?.className).toBeNull();
    expect(free?.isMethod).toBe(false);
  });

  it('does not make nodes for events or errors', () => {
    expect(fn('src.App.App.Started')).toBeUndefined();
    expect(fn('src.App.App.NotOwner')).toBeUndefined();
    expect(fn('src.Engine.Engine.Spun')).toBeUndefined();
  });

  it('captures parameter types and modifier invocations', () => {
    const run = fn('src.App.App.run');
    expect(run?.paramTypes).toEqual({ other: 'Engine', amount: 'uint256' });
    expect(run?.decorators).toEqual(['onlyOwner']);
    expect(run?.isAsync).toBe(false);
  });

  it('keeps the declaration head as the signature', () => {
    expect(fn('src.Engine.Engine.spin')?.signature).toBe('function spin() public returns (uint256)');
    expect(fn('src.App.App.run')?.signature).toBe(
      'function run(Engine other, uint256 amount) external onlyOwner returns (uint256)',
    );
  });

  // ---- state variables: the register signal -------------------------------

  it('tracks state-variable reads and writes as bare identifiers', () => {
    const spin = fn('src.Engine.Engine.spin');
    expect(spin?.selfAttrsRead).toEqual(['rpm']);
    expect(spin?.selfAttrsWritten).toEqual(['rpm']);
  });

  it('tracks writes in a constructor', () => {
    const ctor = fn('src.Engine.Engine.Engine');
    expect(ctor?.selfAttrsWritten).toEqual(['keeper', 'rpm']);
    expect(ctor?.selfAttrsRead).toEqual([]);
  });

  it('sees state inherited from a base contract in ANOTHER file', () => {
    const prepare = fn('src.App.App.prepare');
    expect(prepare?.selfAttrsWritten).toEqual(['cycles', 'total']);
    expect(prepare?.selfAttrsRead).toEqual(['cycles']);
  });

  it('reads state through a modifier body', () => {
    expect(fn('src.App.App.onlyOwner')?.selfAttrsRead).toEqual(['owner']);
  });

  it('does not mistake a parameter that shadows storage for a state access', () => {
    // `run(Engine other, uint256 amount)` — `amount` is a parameter, not storage.
    expect(fn('src.App.App.run')?.selfAttrsRead).not.toContain('amount');
    expect(fn('src.App.App.run')?.selfAttrsRead).toContain('total');
    expect(fn('src.App.App.run')?.selfAttrsWritten).toContain('total');
  });

  it('does not attribute storage touched only inside an assembly block', () => {
    // `spin()`'s assembly writes slot 0; that is not a named state variable.
    expect(fn('src.Engine.Engine.spin')?.selfAttrsWritten).toEqual(['rpm']);
  });

  // ---- call resolution ----------------------------------------------------

  it('resolves a same-contract call and this.f() to self_method', () => {
    expect(edge('src.App.App.run', 'src.App.App.prepare')?.callType).toBe('self_method');
    const both = analysis.edges.filter(
      (e) => e.callerId === 'src.App.App.run' && e.calleeId === 'src.App.App.prepare',
    );
    expect(both).toHaveLength(2); // bare `prepare()` and `this.prepare()`
  });

  it('resolves an inherited function through a scanned base in another file', () => {
    expect(edge('src.App.App.run', 'src.Engine.EngineBase.reset')?.callType).toBe('self_method');
  });

  it('emits an edge for a modifier invocation', () => {
    expect(edge('src.App.App.run', 'src.App.App.onlyOwner')?.callType).toBe('self_method');
  });

  it('resolves a state variable of contract type to self_attr_method', () => {
    expect(edge('src.App.App.run', 'src.Engine.Engine.spin')?.callType).toBe('self_attr_method');
  });

  it('resolves an interface call through a plainly imported file', () => {
    expect(edge('src.App.App.run', 'src.IVault.IVault.deposit')?.callType).toBe('self_attr_method');
  });

  it('resolves a mapping element of contract type', () => {
    const viaMapping = analysis.edges.filter(
      (e) => e.callerId === 'src.App.App.run' && e.raw === 'fleet[msg.sender].spin',
    );
    expect(viaMapping).toHaveLength(1);
    expect(viaMapping[0]?.calleeId).toBe('src.Engine.Engine.spin');
  });

  it('resolves a parameter of contract type to param_method', () => {
    const byParam = analysis.edges.filter((e) => e.callerId === 'src.App.App.run' && e.raw === 'other.spin');
    expect(byParam).toHaveLength(1);
    expect(byParam[0]?.callType).toBe('param_method');
    expect(byParam[0]?.calleeId).toBe('src.Engine.Engine.spin');
  });

  it('resolves a library call to internal_func at the scanned definition', () => {
    const call = edge('src.App.App.run', 'src.MathLib.MathLib.double');
    expect(call?.callType).toBe('internal_func');
  });

  it('resolves an imported free function to internal_func', () => {
    expect(edge('src.App.App.run', 'src.MathLib.shout')?.callType).toBe('internal_func');
  });

  it('resolves new Contract() to internal_constructor', () => {
    expect(edge('src.App.App.run', 'src.Engine.Engine.Engine')?.callType).toBe('internal_constructor');
  });

  it('routes an unscanned import to boundary, keeping the import path', () => {
    const external = edge(
      'src.App.App.run',
      'boundary:@openzeppelin/contracts/token/ERC20/IERC20.sol.transfer',
    );
    expect(external?.callType).toBe('boundary');
  });

  it('routes new UnscannedType() to boundary_constructor', () => {
    expect(edge('src.App.App.run', 'boundary:./vendor/Widget.sol')?.callType).toBe('boundary_constructor');
  });

  it('records a compiler intrinsic as a boundary', () => {
    expect(edge('src.App.App.onlyOwner', 'boundary:require')?.callType).toBe('boundary');
  });

  it('records a low-level value call on an address as a boundary', () => {
    expect(edge('src.App.App.run', 'boundary:address.call')?.callType).toBe('boundary');
  });

  it('leaves an ungroundable bare call unresolved', () => {
    expect(edge('src.App.App.run', 'unresolved:mystery')?.callType).toBe('unresolved');
  });

  it('does not emit an edge for a type cast or an emit statement', () => {
    // `Token(owner)` and `Engine(…)` casts produce no call of their own, and an
    // event has no body to call into.
    const raws = edgesFrom('src.App.App.run').map((e) => e.raw);
    expect(raws).not.toContain('Token(owner)');
    expect(raws.filter((r) => r.includes('Started'))).toEqual([]);
  });

  it('emits no edges from inside an assembly block', () => {
    const spinEdges = edgesFrom('src.Engine.Engine.spin');
    expect(spinEdges.map((e) => e.raw)).toEqual([]);
  });

  it('skips a file the grammar cannot parse instead of throwing', () => {
    expect(analysis.functions.filter((f) => f.file === 'src/Broken.sol')).toEqual([]);
    expect(analysis.functions.length).toBeGreaterThan(0);
  });

  it('produces the whole fixture graph', () => {
    expect(analysis.functions).toHaveLength(11);
    expect(analysis.edges).toHaveLength(18);
  });

  it('produces exactly the callTypes it declares', () => {
    const produced = new Set<CallType>(analysis.edges.map((e) => e.callType));
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect([...declared].filter((t) => !produced.has(t)).sort()).toEqual([]);
  });

  it('declares the capabilities it actually delivers', () => {
    expect(adapter.capabilities.tier).toBe('full');
    expect(adapter.capabilities.selfAttrs).toBe(true);
    expect(adapter.capabilities.statementSpans).toBe(false);
    expect(adapter.statementSpans).toBeUndefined();
  });
});

/**
 * A second fixture for the forms the main one cannot hold at once: the whole-file
 * import alias, `using L for T`, and the `using {f} for T` spelling that the
 * pinned grammar rejects. The last one is the point — a local parse ERROR must
 * not cost the rest of the file.
 */
const TOOLS_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Meter {
    function scaled(uint256 a) internal pure returns (uint256) {
        return a * 3;
    }
}

function normalize(uint256 a) pure returns (uint256) {
    return a;
}
`;

const GAUGE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import * as Tools from "./Tools.sol";
import {Meter} from "./Tools.sol";

contract Gauge {
    using Meter for uint256;
    using {Tools.normalize} for uint256;

    uint256 public level;

    function bump(uint256 by) public {
        level = level.scaled();
        level = Tools.normalize(level + by);
    }
}
`;

describe('SolidityAdapter — awkward but legal source', () => {
  let analysis: ModuleAnalysis;
  const adapter = new SolidityAdapter();

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-sol2-'));
    writeFileSync(join(root, 'Tools.sol'), TOOLS_SOL);
    writeFileSync(join(root, 'Gauge.sol'), GAUGE_SOL);
    analysis = await adapter.analyze(['Gauge.sol', 'Tools.sol'], root);
  });

  const edge = (callee: string) => analysis.edges.find((e) => e.calleeId === callee);

  it('keeps a `using {f} for T` parse error local to that directive', () => {
    // The grammar (tree-sitter-wasms@0.1.13) cannot parse the ≥0.8.13 spelling,
    // yet everything after it in the file must still be extracted.
    expect(analysis.functions.map((f) => f.id)).toContain('Gauge.Gauge.bump');
    expect(analysis.functions.map((f) => f.id)).toContain('Tools.Meter.scaled');
    expect(analysis.functions.map((f) => f.id)).toContain('Tools.normalize');
  });

  it('resolves a `using L for T` member call to the attached library', () => {
    expect(edge('Tools.Meter.scaled')?.callType).toBe('internal_func');
  });

  it('resolves a call through a whole-file import alias', () => {
    expect(edge('Tools.normalize')?.callType).toBe('internal_func');
  });

  it('still tracks state through all of it', () => {
    const bump = analysis.functions.find((f) => f.id === 'Gauge.Gauge.bump');
    expect(bump?.selfAttrsRead).toEqual(['level']);
    expect(bump?.selfAttrsWritten).toEqual(['level']);
  });
});

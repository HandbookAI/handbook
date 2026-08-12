---
'@handbook/core': minor
'@handbook/analyzer': minor
'@handbook/pipeline': minor
'@handbook/renderer': minor
---

Index named types — class, interface, struct, record, enum, trait, alias — as parsed facts,
and declare per adapter which languages that covers.

**The gap.** The IR had `functionNodeSchema` and `boundaryNodeSchema` and no node kind for
a type, so the agent artifact's `symbols.tsv` was a function index wearing a symbol
index's name. Measured on this repository, an exact-name lookup returned **zero rows** for
`HandbookModel`, `StageTree`, `FileCard`, `FunctionNote`, `LanguageAdapter` and
`ChatClient`. `core/src/model.ts` yielded eight rows — `children`, `coerceRole`,
`constructor`, `depth`, `description`, `isCrosscut`, `subtree`, `title` — and not the two
things the file is for. It now yields those two plus fourteen more, each with the line span
of its own declaration.

**`TypeNode` is a sibling of the call graph, not a third kind inside it.** `graph.nodes` is
the call graph's vertex set: every member is a possible edge endpoint, and thirteen places
walk it asking `isInternalNode(node)`. A third `kind` would make every one of them correct
only by remembering to ask, and two are already wrong under that change — `graphDot`'s
`else` files everything non-internal into the "boundary" cluster, and
`metadata.nInternalFunctions` counts `kind === 'internal'`. Types therefore live in
`graph.types` (and `FileCard.types`), so every existing consumer stays correct untouched
and a new one has to name them. It also avoids a real id collision: in TypeScript
`interface Foo {}` and `function Foo() {}` legally coexist, and ids carry a `type:` prefix.

**A type's span is parsed or it does not exist.** `lineStart` is positive by schema. The
interim it replaces derived a class's span from `min..max` of its **methods** — where the
members are, not where the declaration is — and a fabricated line range is the one kind of
wrong an agent cannot detect: a stale path fails to open and a stale name greps nothing,
while a made-up range opens the wrong code in silence.

**Coverage is partial and declared, per invariant 3.** `AdapterCapabilities` grows
`typeKinds`, a list rather than a boolean because the honest answer is per kind — Go has no
`class`, and an adapter could easily find classes and miss every interface. Real extraction
ships for **all twelve full-tier adapters with types**: TypeScript, Python, Go, Rust, Java,
C#, C/C++, Ruby, PHP, Swift, Dart and Solidity. Shell declares `typeKinds: []` because the
language has no named types, and the whole generic tier declares `[]` on purpose — a
pattern-matched type row would be indistinguishable from a parsed one at a lower fidelity,
which is the trap invariant 3 exists to prevent. An empty list is a positive statement, not
a silence. `register.test.ts` runs every adapter against a fixture and compares the
declaration to what was emitted **in both directions**, so an under-claim and an over-claim
both fail the build. `agent/index.md` names which languages are indexed (with their kinds)
and which are not, so an agent that greps a Kotlin interface and finds nothing knows it has
a gap rather than an answer. Where an adapter extracts no types, the labelled
`class-derived` row still covers its classes.

**The vocabulary is closed** — `class` `interface` `struct` `record` `enum` `trait` `alias`
`other` — like `FILE_ROLES`. A construct that fits none of the first seven gets `other`
rather than the nearest-looking bucket: a Go _defined_ type (`type Celsius float64`) is not
an alias, a Rust or C++ `union` is not a struct, a Java `@interface` is not an interface, a
C# `delegate` is not an alias (two with the same signature are distinct types), a Solidity
`library` is not a class (not instantiable, no state) and a Solidity `type X is Y` is not an
alias (it needs wrap/unwrap). A Ruby `module` is `other` for a different reason — one
keyword doing two unrelated jobs, namespace and mixin, with nothing in the declaration
saying which — whereas a Dart `mixin`, whose keyword has exactly one job, is a `trait`.
`TypeNode.signature` carries the declaration **as written**, so `other` never loses the
native keyword.

`symbols.tsv` also stops printing `0` in `nCalledBy` on a row that is not a function: a
type has no callers — `new T()` resolves to `T.constructor` — and `0` in the column an
agent uses to judge blast radius reads as dead code. It is now `-`.

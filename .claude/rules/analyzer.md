---
description: Rules for the static analyzer — never guess a call edge, declare capabilities honestly, test against real source.
paths:
  - packages/analyzer/**
---

# Analyzer rules

**Never guess a call edge.** A call that cannot be pinned down is `unresolved`, and the
graph builder quarantines it into `dropped-calls.json` with a category and its raw text.
A guessed edge is indistinguishable from a real one to everything downstream — grouping,
co-change hints, the agent locator index — so one guess poisons all three at once.

**Two passes, always.** Pass 1 collects declarations and builds type indexes; pass 2
walks call sites with those indexes in hand. `self.attr.method()` cannot be resolved in
one pass, because `attr`'s type is learned from a constructor assignment that may appear
after the call site.

**Declare `capabilities` honestly.** Both tiers produce identical-looking IR, so this
declaration is the only thing stopping a reader from taking a generic-tier edge for a
Python-grade fact. Never inflate `tier`, `selfAttrs` or `statementSpans`.

**Test against real source in a temp directory.** A mocked parse tree proves nothing
about a grammar. Every existing adapter test builds a real mini-repo; follow that shape.

**`web-tree-sitter` is pinned to `~0.25.10`.** 0.26 changed the WASM ABI and fails to
load the bundled grammars. Do not loosen it.

**A broken adapter must not break discovery.** `discoverAll` catches per-adapter
failures and logs them. Keep that behaviour.

**Adding a language changes the docs too.** A drift test fails the build if a registered
language is missing from either README, the analyzer READMEs, the language reference, or
the `DISPLAY` map in `packages/cli/src/docs-drift.test.ts`.

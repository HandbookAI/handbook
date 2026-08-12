# @handbooks/skill

**English** · [中文](README.zh-CN.md)

> Repackage a rendered handbook as an agent SKILL — with a content hash per file, so
> "this page has fallen behind the code" becomes something you can _detect_ instead of
> something you discover the hard way.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fskill-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbooks/skill)
[![no LLM](https://img.shields.io/badge/LLM-never-2dd4bf?style=flat-square)](#)

---

## What it is

Two functions, both deterministic:

- **`buildSkill`** — a rendered handbook directory → a self-contained, shareable SKILL
  package.
- **`validateSkill`** — a SKILL package → a pass/fail report on structure, contract, link
  consistency and freshness.

The package never embeds source code. It ships the _map_, not the territory.

---

## Install

```bash
pnpm add @handbooks/skill
```

---

## Quick start

```ts
import { buildSkill, validateSkill } from '@handbooks/skill';

buildSkill({
  handbookDir: 'work/myrepo/handbook',
  outDir: 'skills/myrepo',
  name: 'myrepo', // slug → skill name `myrepo-handbook`
  project: 'MyRepo', // human name used in prose
  agentDir: 'work/myrepo/handbook/agent', // optional: ship the locator pages
  coverage: { assignment, sourceRoot: '/path/to/repo' }, // optional: drift hashes
  lang: 'en',
});

const result = validateSkill({ skillDir: 'skills/myrepo', sourceRoot: '/path/to/repo' });
result.ok;
result.errors;
result.warnings;
```

From the CLI:

```bash
handbook skill --handbook work/myrepo/handbook --out skills/myrepo \
    --name myrepo --project "MyRepo" \
    --work work/myrepo --source /path/to/repo \
    --agent-dir work/myrepo/handbook/agent

handbook validate --skill skills/myrepo --source /path/to/repo
```

---

## What a SKILL package looks like

```
skills/myrepo/
  SKILL.md                    the routing guide — how an agent should use this
  corrections.jsonl           agent-written feedback (created by the agent, never by the build)
  references/
    overview.md               the system's shape
    index.md                  the stage index — every subsystem → its files
    registers.md              cross-stage state
    stages/<id>.md            one page per stage
    agent/                    index.md + symbols.tsv + files.tsv + calls.tsv + stages/  (optional)
    coverage.json             file → stage + a content hash each   (optional)
```

### `SKILL.md` — the contract

The frontmatter is what an agent runtime routes on:

```yaml
---
name: myrepo-handbook
description: Navigate the MyRepo codebase by behavior and source location. Use when
  planning, implementing, debugging, or reviewing MyRepo work that is unfamiliar, spans
  multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to
  MyRepo or isolated edits where the exact file is already known and no cross-cutting
  impact is plausible.
---
```

**The frontmatter stays English even when the body is Chinese.** That is deliberate:
runtimes select skills by matching against the description text, and the validated
"Use when … / Do not use …" contract is part of that routing surface. Translating it
would silently break selection. Pass `lang: 'zh'` and you get a Chinese body with English
frontmatter.

The body is a numbered routing protocol — read the overview, route through the index,
open only the relevant stage pages, check registers for cross-cutting state, disambiguate
when a term is ambiguous, and **then read the real source at every cited path**. The first
line of the body says it outright:

> This handbook is a **location index** for the codebase, not a code description.

### `coverage.json` — the drift signal

```json
{
  "schemaVersion": 1,
  "summary": { "eligibleFiles": 412, "stages": { "stage-1": 37, "stage-2": 54 } },
  "files": [{ "path": "src/upload.py", "stage": "stage-3", "sha256": "9f2c…" }]
}
```

A hash per file, captured at build time. `validateSkill` re-hashes the live source and
reports every file whose content moved since — which is how an agent learns _"this page
may lag the code"_ before it acts on a stale claim.

### `corrections.jsonl` — the feedback channel

When a handbook claim contradicts the real source, the consuming agent appends one line
of JSON at the **skill root**:

```json
{
  "file": "src/engine.py",
  "page": "references/stages/stage-2.md",
  "claim": "spin() is defined in src/main.py",
  "actual": "spin() is defined in src/engine.py",
  "notedAt": "2026-08-04T12:00:00Z"
}
```

Only `file` is required. It lives at the root, never under `references/`, because
planners mount that tree read-only. `handbook resync --corrections <file>` then refreshes
**exactly the files named in it**.

**A rebuild preserves it.** The build wipes `outDir` first, so pending corrections are
stashed across the clean — records that have not been resynced yet must not be destroyed
by a re-package.

---

## Safety rules the build enforces

- **It refuses to eat its own input.** If `outDir` _is_ the handbook directory, or the
  handbook sits inside it, the build aborts — because it starts by wiping `outDir`, and
  that would delete the very thing being packaged and then quietly emit an empty skill.
- **The agent artifact ships whole or not at all.** `agent/index.md` and all three fact
  tables are copied only when every one of them exists, and the SKILL.md routing protocol
  only gains its grep recipes when they do. `SKILL.md` must never route to a file that is
  not there. `agent/stages/` follows opportunistically — a handbook with no
  content-bearing stage produces none, and that is not a reason to ship no index.

  This is also the delivery channel that was broken for a while: the copy list named two
  pages the renderer had stopped writing, so the entire agent index was generated on every
  run and then never packaged. The probe now uses `AGENT_INDEX_FILE`, exported by the
  renderer, so the two cannot drift again.

- **The register page always exists.** A handbook with zero registers renders no register
  page; the skill still ships one saying so, because a stable reference layout is part of
  the contract.
- **Stage-page discovery is shape-agnostic.** Stage ids are arbitrary (LLM- or
  user-authored), so the flat-layout scan takes every root-level `.md` that is not a known
  top-level page — a name-shape filter would silently drop pages. It deliberately does not
  recurse: `agent/` and `html/` carry their own copies.

---

## What validation checks

| Check                                                            | Severity                 |
| ---------------------------------------------------------------- | ------------------------ |
| `SKILL.md` exists and has YAML frontmatter                       | error                    |
| `name` is a valid lowercase-hyphen slug                          | error                    |
| `description` contains the "Use when … / Do not use …" contract  | error                    |
| `references/overview.md`, `index.md`, `registers.md` all present | error                    |
| At least one stage page under `references/stages/`               | error                    |
| Every stage page linked from `index.md` exists                   | error                    |
| Every stage page is reachable from the index                     | warning                  |
| `coverage.json` parses and matches its schema                    | error                    |
| Source files whose hash moved since packaging                    | warning (listed by path) |
| Only half of the agent locator pair present                      | warning                  |
| `corrections.jsonl` lines parse                                  | warning                  |

`handbook validate` writes warnings and errors to stderr and **exits `2` on failure**, so
it drops straight into CI.

It is also tolerant where tolerance is correct: a leading UTF-8 BOM and CRLF line endings
are accepted, because a `SKILL.md` checked out on Windows is still a valid one.

---

## API

```ts
buildSkill(options: BuildSkillOptions): BuildSkillResult
validateSkill(options: ValidateSkillOptions): ValidationResult

interface BuildSkillOptions {
  handbookDir: string;
  outDir: string;
  name: string;                 // slug; produces `<slug>-handbook`
  project?: string;             // human name in prose; defaults to `name`
  coverage?: { assignment: Assignment; sourceRoot?: string };
  agentDir?: string;
  lang?: 'en' | 'zh';           // body language; frontmatter stays English
}

interface ValidationResult { ok: boolean; errors: string[]; warnings: string[] }
```

---

## Testing

```bash
pnpm --filter @handbooks/skill test
```

Covers both layouts (flat and nested `stages/`), missing pages, the outDir-eats-input
refusal, corrections preservation across rebuilds, BOM/CRLF tolerance, and hash drift
detection.

---

Part of [Handbooks](../../README.md) · MIT

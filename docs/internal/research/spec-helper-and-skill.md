# Functional Specification: `handbook_as_helper` + `build-codebase-handbook` skill

Source trees analyzed (all paths absolute):

- `/Users/jack/Desktop/share/Harness_Handbook/handbook_as_helper/` — the Python helper module
  (`pipeline/*.py`, `handbook_skills/*.py`, `prompts/planner_handbook.md`, `rerun_resync.py`, `README.md`)
- `/Users/jack/Desktop/share/Harness_Handbook/.agents/skills/build-codebase-handbook/` — the
  agent skill (`SKILL.md`, `references/handbook-format.md`, `scripts/*.py`, `agents/openai.yaml`, `LICENSE`)

This document is a complete functional spec sufficient to re-implement both in TypeScript.

---

## 0. System overview

`handbook_as_helper` does exactly two things:

1. **Handbook as planner** — turn a generated codebase *handbook* into an agent SKILL
   (`SKILL.md` + `references/`) and hand it to a **single read-only planner agent** that,
   given a natural-language change request, localizes *every* edit site (including
   scattered/mirror/non-obvious ones) and emits a precise, verbatim EDIT plan.
   **Plan-only**: the planner never edits code, never produces a diff.
2. **Handbook resync** — after a real code change lands (captured as a *case directory*),
   roll the handbook's **derived layer** (function cards, line anchors, code-site lists,
   index) forward to match the change *without* regenerating the whole handbook.
   Two engines: member-level (per-function ledger) and file-level (per-file cards, for
   the "large" pipeline).

The `.agents/skills/build-codebase-handbook` skill is the *manual* counterpart: it
instructs an agent (Codex/Claude) to build, refresh, validate, and use a handbook by hand
inside its own session — no external LLM API — with three helper scripts (inventory,
coverage compiler, validator) plus a deterministic packager.

Directory layout of the helper:

```
handbook_as_helper/
├── README.md (+ README.ru.md, README.zh-CN.md — translations)
├── rerun_resync.py                       # ablation helper (replay resync from a ledger)
├── prompts/
│   └── planner_handbook.md               # the planner system prompt (templated)
├── pipeline/
│   ├── code_agent.py                     # the planner + git-sandbox + agent glue
│   ├── targets.py                        # target-project registry
│   ├── update_handbook.py                # resync CLI entry point
│   ├── resync_handbook.py                # member-level resync engine (A→D)
│   ├── resync_large.py                   # file-level resync engine
│   ├── resync_decl.py                    # generator-free declarations parser
│   ├── resync_llm.py                     # shared bare-HTTP LLM backend
│   ├── lang_layer.py                     # multi-language substrate (spans/gate/fingerprint/graph)
│   └── _recon_terminus_base.py           # rebuild PHASE2_FINAL yaml from index.md (zero LLM)
└── handbook_skills/
    ├── build_skill_from_handbook.py      # generic skill assembler (any target)
    ├── build_handbook_skill.py           # Terminus-2-specific skill carver + register enrichment
    └── handbook_skill_<target>/          # built skills (output)
```

External dependencies (not in this repo, but referenced):
- **NexAU** — the agent framework; specifically its official example agent config
  `NexAU/examples/code_agent/code_agent.yaml`. Provides `Agent`, `AgentConfig.from_dict`,
  the built-in file tools, middlewares, tracing.
- **handbook_generate_small / handbook_generate_terminus** — the member-level handbook
  generator (phase-2 modules `pass_a_classify`, `apply`; phase-3 modules `render_member`,
  `translate_member`; `shared/api_client`; tree-sitter `adapters/` + `phase1/build_graph`).
- **handbook_generate_large** — the file-level generator (phase1 `base`/`build_graph`/`ir`,
  phase2 `read_files`/`file_assign`/`organize_stages`/`nav_pack`/`skeleton_yaml`,
  phase3 `build_handbook`).
- **Harness_Translation** — sibling repo holding pristine phase-2/3 artifacts
  (`handbook/phase2/iterations/final`, `handbook/phase3/output/handbook_en.{md,json}`,
  `handbook/phase3/cache`) and the pristine Terminus-2 source.

Python deps: `pyyaml`, `requests`, `tree-sitter`, `tree-sitter-language-pack` (helper);
skill scripts use **only the Python stdlib** (by design).

---

## 1. `pipeline/code_agent.py` — the handbook planner agent

### 1.1 Module role

"The `handbook` arm": ONE read-only agent that routes with a *navigation-only* copy of
the handbook skill (SKILL.md / index.md / registers.md / stages/<id>.md), reads the REAL
source itself, and emits a verbatim EDIT plan. No locator sub-agent, no map-reduce, no
executor phase. Public entry point:

```python
from code_agent import run_query
out = run_query(query, pristine_dir, workdir)   # arm="handbook" (the only arm)
# -> {"plan": "<natural-language plan text>", "diff": ""}
```

Building blocks (also reused by resync): `_load_official_dict`, `_ensure_nosrc_handbook`,
`_build`/`build_planner`, `_snapshot_git`/`_git_diff`, `_run_agent`/`_dump_trace`,
`_READONLY_TOOLS`, `TARGET`, path constants.

### 1.2 OpenAI env bridge (`_configure_openai_env`, runs at import time)

The NexAU config interpolates `${env.LLM_MODEL}`, `${env.LLM_BASE_URL}`, `${env.LLM_API_KEY}`.
The bridge maps the *standard* OpenAI vars onto those (using `setdefault`, so an explicit
`LLM_*` always wins):

| standard var       | maps to        | default                        |
|--------------------|----------------|--------------------------------|
| `OPENAI_BASE_URL`  | `LLM_BASE_URL` | `https://api.openai.com/v1`    |
| `OPENAI_MODEL`     | `LLM_MODEL`    | `gpt-4o-mini`                  |
| `OPENAI_API_KEY`   | `LLM_API_KEY`  | (required; only set if present)|

A keyless local endpoint: set `OPENAI_API_KEY=EMPTY` explicitly (some key must exist).

### 1.3 Path constants & module-level state

```
HERE          = <module dir>                     (…/handbook_as_helper/pipeline)
HELPER_ROOT   = HERE.parent                      (…/handbook_as_helper)
REPO_ROOT     = HELPER_ROOT.parent               (…/Harness_Handbook)
```
`sys.path` gains `REPO_ROOT/NexAU` or `HELPER_ROOT/NexAU` (first existing) so
`from nexau import Agent, AgentConfig` works. Then `from targets import get_target`.

- `_GIT = ["git", "-c", "user.email=eval@local", "-c", "user.name=eval"]` — fixed identity
  for all sandbox git calls (throwaway repos).
- `TARGET = get_target()` — the active target (env `EVAL_TARGET`, default `terminus2`).
- `HANDBOOK_SKILL = TARGET.handbook_skill` — the full built skill dir.
- `HANDBOOKS_ROOT = HELPER_ROOT / "handbook_skills"`.
- `HANDBOOK_SKILL_NOSRC_REL = HANDBOOKS_ROOT / f"handbook_skill_nosrc_rel_{TARGET.name}"` —
  the navigation-only copy (summary + Relations).
- `PLANNER_PROMPT_HANDBOOK = HELPER_ROOT / "prompts" / "planner_handbook.md"`.
- Official agent dir resolution (`_resolve_official_dir`): env `NEXAU_CODE_AGENT_DIR` wins;
  else first existing of `HELPER_ROOT/NexAU/examples/code_agent`,
  `REPO_ROOT/NexAU/examples/code_agent`; fallback = the REPO_ROOT candidate (for a clear
  not-found error). `OFFICIAL_YAML = OFFICIAL_DIR / "code_agent.yaml"`.
- `_ENV_RE = re.compile(r"\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}")`
- `_REQUIRED_ENV = ("LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY")`
- `_READONLY_TOOLS = {"read_file", "search_file_content", "list_directory", "complete_task"}`
  — the read-only subset of the official tools. Deliberately excludes `write_todos`
  (the plan is the deliverable; the todo tool was seen called malformed).

### 1.4 `_load_official_dict() -> dict`

1. If `OFFICIAL_YAML` missing → `FileNotFoundError` telling the user to set
   `NEXAU_CODE_AGENT_DIR`.
2. If any of `_REQUIRED_ENV` unset → `EnvironmentError` naming the missing vars and
   suggesting `OPENAI_API_KEY` (+ optional `OPENAI_MODEL`/`OPENAI_BASE_URL`) or `LLM_*`.
3. Read the yaml text, substitute every `${env.X}` with `os.environ.get(X, "")` (unknown
   vars like `LANGFUSE_*` become `""` — never hard-fail on tracing config about to be
   dropped), `yaml.safe_load` and return the dict.

### 1.5 `_ensure_nosrc_handbook(dest, keep_rel)` — navigation-only handbook copy

Builds/refreshes `dest` = a copy of `HANDBOOK_SKILL` where every **function card** in
`references/stages/*.md` is collapsed to its **locator line** — the `<details id=…>`
opener plus the `<summary>…</summary>` line — dropping the body (What/Interface/
Execution-flow/Design-decisions/Source). When `keep_rel=True`, the card's
`**Relations**` block is preserved after the summary. `index.md` and `registers.md` are
untouched. If the handbook is plain markdown (no `<details>` cards), the regex matches
nothing → no-op (skill used as-is).

Regexes:
```python
_CARD_TO_SUMMARY = re.compile(r'(<details id="[^"]*">\s*<summary>.*?</summary>).*?(</details>)', re.S)
_RELATIONS_BLOCK = re.compile(r"\*\*Relations\*\*.*?(?=\n</details>)", re.S)
```
Collapse rule: match → `"{summary}\n\n{relations}\n{close}"` if keep_rel and a Relations
block is found inside the match, else `"{summary}\n{close}"`.

Freshness/staleness: `dest/.built_from` stamp file holds the mode string
`f"locator keep_relations={keep_rel}"`. Fresh iff stamp exists, stamp mtime >= max mtime
of any file under the source skill, and stamp content equals the wanted mode.

**Process safety** (parallel eval fan-out, e.g. `xargs -P 8`): a *directory lock*
(`dest.parent/(dest.name + ".lock")`, acquired with atomic `mkdir`) serializes builders.
- Non-holders spin: return if fresh; reclaim locks older than `STALE_SEC = 600` s
  (rmtree the lock and retry); sleep 0.1 s; overall deadline 1800 s → `TimeoutError`.
- Holder: re-check fresh under the lock; remove orphan `dest.name + ".tmp.*"` dirs;
  `copytree(src_skill, tmp)` where `tmp = dest.parent/(dest.name + f".tmp.{pid}")`;
  apply the collapse to each `tmp/references/stages/*.md` (write only if changed);
  write the stamp into tmp; `rmtree(dest)` if it exists; `os.replace(tmp, dest)`
  (atomic swap-in); finally `lock.rmdir()` (ignore errors).
- Errors: missing `src_skill/SKILL.md` → `FileNotFoundError("handbook skill not built yet…")`.

### 1.6 Git sandbox: `_snapshot_git(pristine_dir, workdir)` / `_git_diff(workdir)`

- `_snapshot_git`: `rmtree(workdir)` if exists; `copytree(pristine_dir, workdir,
  ignore=shutil.ignore_patterns(*TARGET.snapshot_ignore))` (ignore only when the target
  has patterns); then in workdir: `git init -q`, `git add -A`, `git commit -q -m pristine`
  (all with the `_GIT` fixed-identity flags, `check=True`).
- `_git_diff`: `git add -A` then `git diff --cached` (captured, text) — diff of the
  working tree vs the "pristine" baseline commit, so **new files are included**. Returns
  stdout. (Reused by resync to diff the handbook copy.)

### 1.7 Agent runner: `_run_agent` / `_dump_trace`

- `_run_agent(agent, task, workdir, label) -> str`: calls
  `agent.run(message=task, context={"working_directory": str(workdir)})`; if the result
  is a tuple take element 0, else `str(result)`. Any exception → print
  `"  !! {label} error: {e!r}"` and return `f"[{label} error] {e!r}"`. In a `finally`,
  always `_dump_trace`.
- `_dump_trace(agent, workdir, label)`: best-effort; serialize `agent.history` (each
  message `.model_dump()`) as pretty JSON (`indent=2, ensure_ascii=False, default=str`)
  to `workdir.parent / f"{label}_trace.json"`. On failure, write
  `f"[trace dump failed] {e!r}"` there instead; swallow all errors.

### 1.8 `_build(system_prompt, name, use_handbook, handbook_dir=None) -> Agent`

Builds the read-only planner from the official config + documented glue:

1. `cfg = _load_official_dict()`.
2. `cfg.pop("tracers")` — no tracing.
3. `cfg["tools"] = [t for t in cfg["tools"] if t["name"] in _READONLY_TOOLS]`.
4. `cfg.pop("sub_agents")` — flat planner.
5. `cfg["system_prompt"] = TARGET.render_prompt(system_prompt.read_text())`;
   `cfg["system_prompt_type"] = "string"` (raw string, no jinja); `cfg["name"] = name`.
6. Env knobs (every one tunable without editing the yaml):
   - `NEXAU_TOOL_CALL_MODE` → `cfg["tool_call_mode"]` (default = yaml's `structured`).
   - Temperature: default greedy `0.0` (`LLM_TEMPERATURE` overrides). If
     `LLM_NO_TEMPERATURE` set: remove `temperature` from `llm_config` and append
     `"temperature"` to `llm_config.additional_drop_params` (for models rejecting it).
   - `cfg["llm_config"]["max_tokens"] = int(env LLM_MAX_TOKENS or yaml value or 32000)`
     (uses `or`, so empty-string env falls back).
   - `cfg["max_context_tokens"] = int(env LLM_MAX_CONTEXT or yaml or 200000)`.
   - `cfg["max_iterations"] = int(env LLM_MAX_ITERATIONS or yaml or 300)`.
   - `LLM_EXTRA_BODY` (JSON string) → merged (`update`) into `llm_config.extra_body`
     (provider-specific request-body fields, e.g. DeepSeek thinking toggle).
   - `LLM_CACHE_TTL` (default `"1h"`, `""` disables) → `llm_config.cache_control_ttl`
     (cost lever; no-op on OpenAI-compatible paths, extends Anthropic cache window).
   - `LLM_API_TYPE` (e.g. `anthropic_chat_completion`) → sets `llm_config.api_type`,
     forces `stream=False`, removes `temperature`, sets
     `additional_drop_params=["temperature"]`.
   - Tool-output truncation: for each middleware dict whose `import` string contains
     `"LongToolOutput"`, set `params.max_output_chars = int(env TOOL_OUTPUT_LIMIT or 300000)`
     (so one `read_file` returns a whole file untruncated).
7. If `use_handbook`: `hb = handbook_dir or HANDBOOK_SKILL`; require `hb/SKILL.md`
   (else `FileNotFoundError`). Append to the (already target-rendered) system prompt:

   ```
   ## Where the handbook lives
   The handbook is at `<hb>`. Read `<hb>/SKILL.md` first (its
   navigation guide), then the reference files it names — e.g.
   `<hb>/references/index.md`, [`<hb>/references/disambiguation.md` (search-word disambiguation), ]`<hb>/references/registers.md`,
   and `<hb>/references/stages/<id>.md` — with `read_file` (absolute paths).
   There is NO LoadSkill tool; access the handbook only by reading these files.
   ```
   The disambiguation clause is included only when `<hb>/references/disambiguation.md`
   exists. This is **progressive disclosure by path** — no auto-injected LoadSkill tool.
8. `return Agent(config=AgentConfig.from_dict(cfg, base_path=OFFICIAL_DIR))`.

### 1.9 `build_planner(arm="handbook") -> Agent`

Only `"handbook"` is valid (else `ValueError`). Ensures the nosrc handbook
(`_ensure_nosrc_handbook(HANDBOOK_SKILL_NOSRC_REL, keep_rel=True)`) then
`_build(PLANNER_PROMPT_HANDBOOK, f"{TARGET.name}_planner_{arm}", use_handbook=True,
handbook_dir=HANDBOOK_SKILL_NOSRC_REL)`.

### 1.10 `run_query(query, pristine_dir, workdir, arm="handbook") -> dict`

PLAN-ONLY. Steps:
1. `_snapshot_git(pristine_dir, workdir)` — fresh git sandbox copy.
2. `os.environ["SANDBOX_WORK_DIR"] = str(workdir.resolve())` — **critical**: NexAU's
   built-in file tools resolve relative paths against `sandbox.work_dir`, which defaults
   to `$SANDBOX_WORK_DIR`; the `context={"working_directory": …}` passed to `agent.run`
   is ignored by the file tools.
3. `planner = build_planner(arm)`.
4. Wrap the query:
   ```
   A code reviewer has requested the following change to the target harness. Produce a precise plan of the edits needed (do NOT edit anything yet).

   === REVIEWER REQUEST ===
   <query.strip()>
   ========================
   ```
5. `plan = _run_agent(planner, plan_task, workdir, "planner")` (trace →
   `workdir.parent/planner_trace.json`).
6. `shutil.rmtree(workdir, ignore_errors=True)` — drop the sandbox.
7. Return `{"plan": plan, "diff": ""}`.

---

## 2. `prompts/planner_handbook.md` — the planner prompt

Full intent: a senior-engineer *planning* persona that must produce a byte-exact,
self-contained edit plan that a mechanical executor can apply blindly (exact OLD→NEW
substitution, no re-reading). Contains `{{PLACEHOLDER}}` slots substituted by
`Target.render_prompt` (unknown placeholders left untouched).

Structure (section by section):

1. **Header**: "You are a senior software engineer PLANNING a change to {{PROJECT_INTRO}},
   on behalf of a code reviewer." Given ONE natural-language change request; produce a
   precise, SELF-CONTAINED PLAN — no edits; the executor substitutes exact OLD with exact
   NEW without re-reading, so verbatim text must be byte-exact.
2. **"Two artifacts, two distinct roles"**:
   - *The handbook* is a pure **LOCATION INDEX**, not a code description. Each function is
     a one-line locator `` <summary><b>Qualified.name</b> — file:start-end · one-line role</summary> ``
     optionally followed by a `**Relations**` block (callers/callees/register read-write
     sites). No body, no source. `index.md` lists every stage with its function locators;
     `registers.md` lists every state variable with exact read/write sites. Use these to
     decide WHICH files/functions/sites are in scope — they surface scattered, non-obvious
     sites (mirror copies in the other parser/template, a register's every read/write,
     cross-subsystem touch points) a plain text search can miss.
   - *The real source* is GROUND TRUTH for WHAT to change. Handbook gives ADDRESS; the
     code at that address is the only reliable structure. "You MUST read the real source."
3. **"How to plan — ROUTE with the handbook, READ the real source, EMIT verbatim edits"**
   (6 numbered steps): (1) understand true intent (behavior delta + state/conditions/values);
   (2) route with handbook — SKILL.md, then index.md, then only the stages/<id>.md chapters
   and registers.md entries the intent points to; assemble the candidate set; watch for
   scattered/mirror sites (a parser change usually has a twin in the OTHER parser and both
   prompt templates; a state change fans out to every read site under that register);
   (3) `read_file` the REAL source of every site to be edited — confirm exact body/control
   flow/conditions; (4) for EACH edit produce a self-contained EDIT BLOCK whose `old_string`
   is copy-pasted verbatim from the read_file output (never retyped/paraphrased), whitespace
   exact, ≥3 context lines before AND after so the snippet is UNIQUE in the file;
   (5) note/add edits for silently-broken coupled assumptions; (6) only include edits the
   request confidently requires.
4. **EDIT BLOCK format** (exact template):

   ```
   ### EDIT <n>
   - file: `<path relative to the working dir, e.g. {{PATH_EXAMPLE}}>`
   - where: `<{{WHERE_EXAMPLE}}>` — why this change
   ```old
   <EXACT current text, copied verbatim from read_file — whitespace-perfect, unique>
   ```
   ```new
   <the replacement text — correct, idiomatic, the smallest change that realizes the intent>
   ```
   ```
5. **Rules for the blocks** (executor trusts blindly):
   - `old` MUST be byte-exact; re-`read_file` the region if unsure.
   - Keep each `old` the SMALLEST still-unique span (1–8 lines typically); no whole functions.
   - **SAME-FILE edits must NOT overlap**: blocks apply in order against already-changed
     text without re-reading; no block's `old` (incl. context) may contain a line another
     same-file block changes; merge close-by changes into ONE block; order top-to-bottom.
   - Brand-NEW file: single block, empty ```old```, full content in ```new```,
     "(new file)" in `where`.
   - Anchor on stable lines; never span an unsure region.
6. **Completion instruction**: call `complete_task` with a short prose summary, then ALL
   EDIT blocks, then the declarations JSON. Do NOT edit files.
7. **Declarations (machine-readable — the handbook-resync pipeline consumes this)**:
   end with EXACTLY one ```json block declaring the change-set at FUNCTION granularity,
   using {{QUALNAME_NOTE}}:

   ```json
   {{DECL_JSON}}
   ```
   - `will_modify` — every EXISTING function whose implementation changes.
   - `will_add` — every brand-new function introduced.
   - `will_remove` — every function deleted outright. A rename = remove(old)+add(new).

Placeholders used by this prompt: `{{PROJECT_INTRO}}`, `{{PATH_EXAMPLE}}`,
`{{WHERE_EXAMPLE}}`, `{{QUALNAME_NOTE}}`, `{{DECL_JSON}}`. (Targets also define others —
`{{PROJECT}}`, `{{LANGUAGE}}`, `{{CODEBASE_DESC}}`, `{{BASELINE_READ_STEP}}`,
`{{PATH_EXAMPLE2}}`, `{{VALID_LANG}}`, `{{REPLACE_*}}` — for other/legacy prompts.)

---

## 3. `pipeline/targets.py` — target project registry

Generic project-config layer. Select via `EVAL_TARGET` env (or `--target`/explicit name);
default `terminus2`. Adding a project = registering one more `Target`; no other code changes.

### 3.1 `Target` dataclass (frozen)

| field | type | meaning |
|---|---|---|
| `name` | str | short id (`"terminus2"`, `"codex"`) |
| `language` | str | `"python"` \| `"rust"` \| … (drives the syntax gate + lang_layer) |
| `source_globs` | tuple[str, …] | source-file globs (e.g. `("*.py",)`) |
| `snapshot_ignore` | tuple[str, …] | names skipped by `_snapshot_git`'s copytree |
| `syntax_mode` | str | `"python"` \| `"command"` \| `"none"` (post-apply gate) |
| `_pristine` | callable → Path | pristine source root resolver (deferred) |
| `_golden` | callable → Path | golden query suite yaml resolver |
| `_handbook_skill` | callable → Path | built skill dir resolver |
| `_handbook_rendered` | callable → Path\|None | optional rendered-handbook dir resolver (default `lambda: None`) |
| `syntax_command` | str\|None | shell command for `syntax_mode=="command"` (cwd=sandbox; nonzero=broken; `$EVAL_SYNTAX_CMD` overrides) |
| `prompt_vars` | dict | `{{KEY}}` → wording substitutions for prompts |

Resolved properties (env override wins over the resolver):
- `pristine_root` — `$PRISTINE_ROOT` else `_pristine()`
- `golden` — `$GOLDEN` else `_golden()`
- `handbook_skill` — `$HANDBOOK_SKILL_DIR` else `_handbook_skill()`
- `handbook_rendered` — `$HANDBOOK_RENDERED_DIR` else `_handbook_rendered()`

`render_prompt(template) -> str`: replace each `"{{"+k+"}}"` with `v` for every
`prompt_vars` item; unknown placeholders untouched (plain prompt = no-op).

Path resolution convention: `_first_existing(*candidates)` — first that exists, else the
first candidate (clear not-found error later).

### 3.2 Registered targets

**terminus2** (Python): `source_globs=("*.py",)`,
`snapshot_ignore=(".git","__pycache__",".mypy_cache",".pytest_cache")`,
`syntax_mode="python"`. Pristine: `<Harness_Translation>/harbor/src/harbor/agents/terminus_2`
else `<REPO_ROOT>/harbor/src/harbor/agents/terminus_2`. Golden: several
`golden_task_request/terminus2_val*.yaml` candidates. Skill:
`HELPER_ROOT/handbook_skills/handbook_skill_terminus`. `prompt_vars` include
`PROJECT="Terminus-2"`, `LANGUAGE="Python"`, `PROJECT_INTRO="a Python agent harness
called Terminus-2"`, `PATH_EXAMPLE="terminus_2.py"`,
`WHERE_EXAMPLE="Class.method (~line)"`, `QUALNAME_NOTE` ("fully qualified names
(`Class.method`, nested as `Class.method.inner`) exactly as they appear"), and a
`DECL_JSON` example:
```json
{"will_modify": ["Terminus2._run_agent_loop", "Terminus2._check_timeout"],
 "will_add":    ["Terminus2._upload_report"],
 "will_remove": []}
```

**codex** (Rust, codex-rs workspace): `source_globs=("*.rs",)`,
`snapshot_ignore=(".git","target","node_modules",".cargo")` (never copy build output),
`syntax_mode="none"` with `syntax_command="cargo check -q"` (opt-in). Pristine:
`<REPO_ROOT>/codex/codex-rs` else sibling. Skill: `handbook_skill_codex`.
`_handbook_rendered=_find_rendered_handbook("codex")`. Prompt vars use Rust wording:
`WHERE_EXAMPLE="module::function or Type::method (~line)"`, `QUALNAME_NOTE` = "fully
qualified Rust paths (`module::function`, an impl method as `Type::method`) as they
appear", DECL_JSON example uses `session::turn::run_turn` etc.

`_find_rendered_handbook(project)` returns a resolver that scans
`REPO_ROOT/handbook_generate*/work/<project>*/handbook` for dirs with `index.md` +
`stages/`, sorts preferring the exact `<project>/handbook` (non-`_zh`), returns first
or None.

### 3.3 API

- `get_target(name=None) -> Target`: key = `(name or $EVAL_TARGET or "terminus2").strip().lower()`;
  unknown → `ValueError` listing registered names.
- `target_names() -> list[str]` (sorted).

---

## 4. Resync subsystem

### 4.1 The case_dir contract

A *completed case directory* describes one real code change:

```
<case_dir>/
├── edited/       the changed source tree (required)
├── plan.md       description of the change; its ```json declarations block drives the reconcile (required for member-level; optional for file-level)
└── agent.diff    (optional) diff of edited/ vs pristine — if present AND empty → case skipped ("nothing to resync")
```

Outputs written back into the case dir by a member-level resync:
- `plan_check.json` — `{"declarations": {...}, "ok": bool, "errors": [...]}`
- `handbook/` — git-snapshotted copy of the handbook references, edited in place
- `mapping.updated.yaml` — the rolled ledger
- `resync_report.json` — the full report (or `{"fatal": "<repr>"}` on failure)
- `handbook_final.diff` — `git diff --cached` of the handbook copy vs its baseline
- `resync_llm_usage.jsonl` — one record per resync LLM call
- `cache_translate/` — per-case translation cache

File-level resync outputs: `handbook_large/` (snapshotted large skill), `resync_report.json`,
`handbook_final.diff`, `resync_llm_usage.jsonl`.

### 4.2 Declarations format & parsing (`resync_decl.py`, duplicated in `resync_handbook.py`)

Declarations JSON (in plan.md):
```json
{"will_modify": ["Qual.name", ...], "will_add": [...], "will_remove": [...]}
```

`parse_declarations(plan_text) -> dict`:
- Scan ALL ```json fenced blocks (`re.finditer(r"```json\s*(.*?)```", text, re.S)`).
- The **LAST** parseable block containing any of the keys
  `("will_modify","will_add","will_remove")` wins (later blocks overwrite earlier).
- For each key: keep only string items of a list value; a non-list value → `[]`.
- Tolerant: missing/broken block → all-empty lists (the sha verdict then reports the
  whole change-set as "unplanned"; resync still works, just noisier).

`resync_decl.py` exists so the FILE-level engine can parse declarations without importing
the member engine (which hard-fails to import under `HANDBOOK_GEN_SCALE=large`).

`validate_declarations(decl)` (member engine only; "①.5 mechanical check", zero LLM):
load `PHASE2_FINAL/mapping.yaml`; `known` = set of qualnames of members with
`type in ("function","region")`. Errors: `will_modify`/`will_remove` naming a qualname
NOT in the ledger; `will_add` naming one already in the ledger. Returns
`{"ok": not errors, "errors": [...]}`.

### 4.3 `update_handbook.py` — resync CLI entry point

```
python pipeline/update_handbook.py <case_dir> [...] [--target T] [--no-translate] [--narrate-lang en|zh]
```

Module constants:
- `HANDBOOK_REFS`: `$HANDBOOK_REFS` env, else first existing of
  `handbook_skills/handbook_skill_terminus/references`, `handbook_skill/references`
  (legacy), fallback the first. This is the handbook whose *per-case copy* the member
  resync edits.
- `HANDBOOK_LARGE_SKILL`: `$HANDBOOK_LARGE_SKILL` env, else
  `handbook_skills/handbook_skill_large`.

`main()` flow:
1. Parse args; `target = get_target(args.target)` (default `$EVAL_TARGET` or terminus2).
2. If `$HANDBOOK_GEN_SCALE` ∈ {`large`,`big`} → for each case:
   `resync_case_large(case, target.pristine_root, lang=target.language,
   narrate_lang=args.narrate_lang)`. (Never imports the member engine.)
3. Else (member level): import `lang_layer`; refuse if `target.language` not in
   `supported_languages()` (SystemExit with adapter hint).
   `source_exts = tuple(ext_of(g) for g in target.source_globs) or (".py",)`.
   `translate_cards = not --no-translate and $RESYNC_TRANSLATE not in {"0","false","off"}`
   (default "1"). For each case: `resync_case(...)`.

`resync_case(case_dir, pristine, translate_cards=True, lang="python", source_exts=(".py",))`:
1. Require `edited/` + `plan.md` (else SystemExit "not a completed case dir").
2. If `agent.diff` exists and is empty (stripped) → print skip, return None.
3. `decl = parse_declarations(plan.md)`; `check = validate_declarations(decl)`;
   write `plan_check.json` = `{"declarations": decl, **check}`; print first 3 errors if red.
4. `_snapshot_git(HANDBOOK_REFS, case_dir/"handbook")` — a git copy of the references.
5. `rep = resync(edited, handbook_sandbox, pristine, decl,
   mapping_out=case_dir/"mapping.updated.yaml", translate_cards=…, lang=…, source_exts=…)`.
   Any exception → write `{"fatal": repr(e)}` to resync_report.json, return None
   (a resync failure must not lose the run).
6. Write `resync_report.json` (pretty), `handbook_final.diff` (`_git_diff(handbook)`).
7. Print a one-line summary: counts of unchanged/changed/removed/renamed/new, anchors
   refreshed, cards patched/rewritten/deleted (+PENDING if translation off), errors;
   plus reconcile `missed=`/`unplanned=` and "end checks RED" when applicable.

`resync_case_large(case_dir, pristine, *, lang, narrate_lang, build=True)`:
requires `edited/` (plan.md optional); empty agent.diff → skip; require
`HANDBOOK_LARGE_SKILL` exists (SystemExit hint otherwise); parse decl lazily via
`resync_decl` when plan.md exists; `_snapshot_git(HANDBOOK_LARGE_SKILL, case/"handbook_large")`;
`rep = resync_large(edited, skill_sandbox, pristine, lang=…, narrate_lang=…, decl=…,
report_out=case/"resync_report.json", build=build)` (exception → fatal report, None);
write `handbook_final.diff`; print counts.

### 4.4 `resync_llm.py` — shared LLM backend

Also duplicated privately inside `resync_handbook.py` as `_EnvLLM`/`_get_api` (same
behavior). Contract: `.call(prompt, params=None) -> LLMCallResult` mirroring the
generators' `api_client.Api` so classification/translation code can't tell backends apart.

- Endpoint resolution (works without code_agent's env bridge):
  `base = LLM_BASE_URL or OPENAI_BASE_URL or "https://api.openai.com/v1"` (rstrip "/");
  `model = LLM_MODEL or OPENAI_MODEL or "gpt-4o-mini"`;
  `key = LLM_API_KEY or OPENAI_API_KEY` — **required**, else `EnvironmentError`
  ("set OPENAI_API_KEY… for keyless local endpoint set OPENAI_API_KEY=EMPTY").
  `extra` = parsed `$LLM_EXTRA_BODY` JSON if set.
- `call(prompt, params=None)`: POST `{base}/chat/completions` with headers
  `Content-Type: application/json`, `Authorization: Bearer {key}`; body
  `{"model", "temperature": 0.0, "max_tokens": 12000,
    "messages": [{"role": "user", "content": prompt}], **extra, **(params or {})}`;
  timeout 600 s. `raise_for_status`; `text = choices[0].message.content or ""`;
  `log_usage(model, data["usage"])`; return `LLMCallResult(raw_text=text,
  status_code, request_id="", elapsed_sec, parsed_json=_extract_json_block(text))`.
  (`LLMCallResult` and `_extract_json_block` imported lazily from the active generator's
  `api_client` — the caller must have put the generator's `shared/` on sys.path.)
- Retries: `max_retries=3`, linear backoff `backoff_sec * attempt` (2 s, 4 s); re-raise last.
- Usage ledger: `set_usage_path(path)` (unlinks existing — fresh per run; None disables),
  `set_phase(str)` tags subsequent records; `log_usage` appends one JSON line
  `{"phase", "model", "in": prompt_tokens, "out": completion_tokens[, "cached": N]}`
  where `cached` comes from `usage.prompt_cache_hit_tokens` or
  `usage.prompt_tokens_details.cached_tokens`; thread-locked; OSError swallowed
  ("accounting must never break resync").
- `get_api()` — process-wide singleton; `set_api(api)` — test injection.

### 4.5 `resync_handbook.py` — member-level engine (A→D)

**Design: SEMANTICS FIRST BY NAME, COORDINATES LAST.** Old line numbers never
participate in any judgment; "who changed" = declarations + per-function content
fingerprint; "where everything is" is recomputed wholesale from the new tree's AST at
the very end. LLM appears ONLY at (C) classification of changed/new functions and (D)
translation/patching of their cards; everything else is table lookup + AST + hashing +
arithmetic + grep.

**Generator resolution** (`_resolve_gen`): `$HANDBOOK_GEN_ROOT` wins; `$HANDBOOK_GEN_SCALE`
large→`handbook_generate_large` (which then fails import with a clear message — the
member engine cannot drive the file-level API), small/member→`handbook_generate_small`;
default: first existing of `handbook_generate_terminus`, `_small`, `_large`,
`handbook_generate`. sys.path gains `<gen>/phase3`, `<gen>/phase2`, this dir, and
`handbook_skills/`. Imports: `pass_a_classify as pa`, `apply as p2apply`
(phase-2), `render_member._slug`/`render_unit`, `translate_member.{build_prompt,
collect_units, load_cached, save_cached, validate_translation}` (phase-3),
`build_handbook_skill as bhs` (this repo), `lang_layer as _L`. Missing module →
`ModuleNotFoundError` with full guidance.

**Inputs/paths**:
- `PHASE2_FINAL` = `$PHASE2_FINAL` else `<Harness_Translation>/handbook/phase2/iterations/final`
  — must contain `mapping.yaml` + `skeleton.yaml` (the function-level ledger + stage tree).
- `PRISTINE_HANDBOOK_JSON` = `<Harness_Translation>/handbook/phase3/output/handbook_en.json`
  (optional; sibling synopses enrichment).
- `UPSTREAM_CACHE` = `<Harness_Translation>/handbook/phase3/cache` (optional; phase-3's
  translate cache — checked first).
- `CACHE_ROOT` default `pipeline/cache/translate_resync`; **overridden per case** to
  `<case>/cache_translate` (a shared cache dir caused parallel cases to overwrite each
  other's entries; per-case keeps same-case rerun hits and kills contention).
- `LANG = "en"` (card language).

**`resync(code_dir, hb_dir, pristine_dir, decl, mapping_out=None, translate_cards=True,
lang="python", source_exts=(".py",)) -> report`** — the driver:

Report skeleton:
```python
{"verdicts": {}, "missed": [], "unplanned": [], "renamed": [], "removed": [], "new": [],
 "unassigned": [], "anchors_refreshed": 0, "cards_translated": [], "cards_patched": [],
 "cards_deleted": [], "cards_pending": [], "repaired_files": [], "frozen_files": [],
 "errors": [], "check": {}}
```

Setup: point `_USAGE_PATH` at `<mapping_out.parent>/resync_llm_usage.jsonl` (unlink
first); per-case `CACHE_ROOT`; load `mapping.yaml` + `skeleton.yaml`; `original =
deepcopy(mapping)` (old envelopes for anchor refresh). Build
`units: {qualname: [(stage_id, member_dict), ...]}` over members with
`type in ("function","region")` and a `line_range`.

**Syntax gate** (`_syntax_gate`): check only the mapped files (never the whole tree).
A file that doesn't parse is **FROZEN** — its ledger entries and cards untouched (a
failed parse would misread every function in it as removed → card-deletion cascade).
Python EOF-tail corruption auto-repair first: `_trim_eof_garbage(py, err_lineno,
max_trim=8)` — a known executor failure appends truncated fragments after the real last
line; only acts if the error is within the last `max_trim` lines; strips trailing lines
one at a time until the file compiles (no write if never). Repaired files →
`report["repaired_files"]`; frozen → `report["errors"]` + `bad_files`.

Span extraction: for each mapped file, `spans_old` from pristine, `spans_new` from
edited (skipping frozen/missing files — a missing edited file is frozen with an error);
`lines_old`/`lines_new` cached. Errors freeze rather than crash.
`report["frozen_files"] = sorted(bad_files)`.

**B — sha verdicts** (by name; position-independent): for each ledger qualname:
- file frozen → `"unparsable"`.
- absent from pristine spans → `"unparsable"` + error "not found in pristine AST — frozen".
- absent from new spans → `"gone"` (candidate removed).
- else compare `sha1("\n".join(lines[start-1:end]))` old vs new (full span text incl.
  signature) → `"unchanged"` / `"changed"`. (Equal fingerprint of a *shifted* function
  still compares EQUAL because the hash is of the span text, not positions.)

**New defs**: any qualname in `spans_new[f]` that is neither in `units` nor in
`spans_old[f]` → `new_defs[q] = (fname, span)`.

**Renames**: for each `gone` qualname, compute
`_L.body_fingerprint(old_span_lines, lang)` (hash of everything BELOW the signature
line — name- and position-independent) and look for a **same-file** new def with an
identical body fingerprint. Match → `renames[old]=new`, verdict `"renamed"`, remove
from `new_defs` and `gone`. `all_new` snapshot taken before consumption so a declared
rename's add-target still counts as fulfilled. `report["renamed"] = ["old -> new", ...]`.

**Reconcile vs declarations**:
- `missed` = declared modify but verdict unchanged; declared remove but verdict
  unchanged/changed; declared add never appearing in `all_new`.
- `unplanned` = changed but not declared modify; gone but not declared remove; new def
  not declared add. (Unplanned changes are still processed — "upgraded".)
- `report["verdicts"]` sorted; `report["removed"] = sorted(gone)`.

**A/C — semantic roll on the ledger**:
- removed → `_drop_entries(q)` (delete every member with that qualname).
- renamed → member dicts mutated in place: `mem["qualname"] = new_q` (body identical ⇒
  stage/purpose/region structure survive; coordinates roll later).
- changed + new → ONE classification round each over the NEW source:
  - `_classify_propose(api, qualname, span, fname, mapping_doc, skeleton, graph, code_dir)`
    — PURE LLM half: build phase-2 actor prompt via
    `pa.render_source_with_line_numbers(file, start, end)`,
    `pa._build_caller_callee_context(qualname, graph, mapping_doc)`,
    `pa._build_stage_overview(mapping_doc)`, `pa.build_actor_prompt(node, src, skeleton,
    callers, callees, overview) + "\n\n" + pa._PROPOSAL_SCHEMA_HINT + "\n\nReturn ONLY
    the JSON proposal object, no other text."`; result must be a dict with
    `proposal["qualname"] == qualname` (else None); setdefault `file` and
    `line_range=[start,end]`. Proposals are fetched **concurrently**
    (`RESYNC_WORKERS`, default 1) via ThreadPoolExecutor over
    `targets = changed (sorted) + new (sorted)`; graph = `_L.fresh_graph(code_dir, lang,
    source_exts[0])`.
  - `_apply_proposal(prop, skeleton, mapping_doc, code_dir)` — SERIAL write-back:
    `p2apply.apply_classification(mapping_doc, prop, code_dir,
    valid_stage_ids={stage ids of skeleton})` (region ranges AST-snapped inside).
    Applied strictly serially in the original target order ⇒ mapping identical
    regardless of worker count.
  - Success on a new def → `report["new"].append(q)`.
  - **Fallback** (proposal error / rejected / apply failed → `report["errors"]`):
    build a whole-function member
    `{"qualname", "type": "function", "file", "line_range": [s,e], "sha1": sha1(segment),
    "purpose": old purpose (changed) | "(new function added by a code change)" (new)}`.
    Changed: drop old entries, append to its old primary stage. New: find a host stage —
    the first ledger function whose NEW span text matches `\b<shortname>\s*\(`
    (regex `(?<!\w)re.escape(short)\s*\(`) → append to that caller's stage +
    `report["new"]`; else append `{"qualname","file","reason":"new function;
    classification failed, caller unknown"}` to `mapping["unmapped_functions"]` +
    `report["unassigned"]`.

**C — coordinates last**: for every surviving member NOT freshly classified
(unchanged/renamed; skip frozen "unparsable"):
- functions: `line_range = [new_start, new_end]` from `spans_new`.
- regions: pure arithmetic — `delta = new_fn_start − old_fn_start`;
  `line_range = [a+delta, b+delta]` (valid because equal fingerprint ⇒ verbatim body).
- `sha1` recomputed from the new text of the resulting range.
If `mapping_out` given: set `mapping["metadata"]["resynced_by"]="handbook_as_helper_v2"`,
write yaml (`allow_unicode=True, sort_keys=False`).

**D — handbook writeback**:

*Envelopes*: `(stage_id, qualname) -> ((min start, max end) over that pair's members, file)`
computed for `original` (old) and rolled `mapping` (new).
`retranslate_quals = changed ∪ new_defs ∪ renames.values() ∪ {renames.get(q,q) for q in changed}`.

*Card surgery primitives* (regex-based, over `hb_dir/stages/*.md`):
- `_card_re(slug)` = `<details id="slug">.*?</details>\n?` (dotall). Slug via phase-3's
  `_slug(qualname)`.
- `_delete_cards(hb_dir, slug, only=None)` — remove first occurrence per hosting file.
- `_refresh_anchor(hb_dir, qualname, fname, old_env, new_env)` — rewrite ONE card's
  `file.py:a-b` summary range identified by its OLD envelope (multi-chapter functions
  have several same-slug cards; the envelope disambiguates). Pattern:
  `(<summary><b>{qual}</b>\s*—\s*{fname}:){old_a}-{old_b}\b` → group + `new_a-new_b`,
  first match wins. Any `(N regions)` suffix untouched.
- `_rename_card_summary(hb_dir, old_q, new_q)` — mechanical swap of the `<details id>`
  slug and the `<summary><b>…</b>` qualname; prose kept (used when translation OFF).
- `_chapter_file(hb_dir, sid, mapping, exclude)` — `stages/{sid}.md` if it exists, else
  a file hosting a card of another member of that stage, else None.

*Anchor refresh pass* (`_anchor_pass(only, skip)`): for each old envelope,
`q_now = renames.get(q,q)`; skip if filtered, in `skip`, or verdict
unparsable/gone; `ne = env_new[(sid, q_now)]` or, when classification MOVED the function
(old sid has no new envelope), the function's UNIQUE new envelope if exactly one; if the
range differs and `_refresh_anchor` succeeds → count. With translation ON,
about-to-be-retranslated cards are skipped (their replacement carries fresh anchors);
with OFF, every surviving card's coordinates roll (stale prose or not). Renamed cards get
the mechanical name swap BEFORE this pass when translation is OFF (regex must match the
new qualname).

*Deletions*: removed (+ renamed-from when translating) → `_delete_cards`; recorded in
`cards_deleted`.

*Translation OFF*: `cards_pending = sorted(retranslate_quals)`; retranslate set cleared —
everything mechanical still ran (verdicts, ledger, coordinates, anchors, deletions,
registers, index); changed keep old prose w/ correct anchors; new get no card.

*Translation ON — jobs*: for each qual (sorted), group its mapping members
`by_sid`; per-qual stage order = OWN-chapter sids first (`stages/{sid}.md` exists),
then by sid (a sid without its own chapter lands in a sibling HOST file and must never
steal the host's same-slug card slot — appended instead). `jobs[(q,sid)] =` members
sorted by line_range start.

*Card build (parallel via RESYNC_WORKERS; pure calls)* — `_xlate(key)`:
1. **Minimal-patch path** (default ON, disable `RESYNC_MINIMAL_PATCH=0`): a CHANGED
   (not new) function that still has an existing card + both spans → build a unified
   diff of just that function (`difflib.unified_diff` over the old/new span lines,
   fromfile `"{fname} (old)"`, tofile `"{fname} (new)"`) and one LLM call with
   `_PATCH_PROMPT` (verbatim intent): reuse the current card as baseline; keep unaffected
   sentences BYTE-FOR-BYTE; change only facts the diff affects (one-line role, Relations
   entries); return unchanged if nothing affected; do NOT touch the `file.py:NN-NN`
   summary range (corrected automatically afterwards); keep exact card structure
   (`<details id>`, `<summary><b>…</b>`, `**Relations**` block with its four bullet
   labels, `</details>`); output ONLY the card, no fences. Reply: strip stray code
   fences; structural check `_card_struct_ok` — single `<details>`/`</details>` pair,
   right slug + qualname, and all of `("**Relations**","**Callers**","**Core callees**",
   "**Config / state sources**","**Results to**")` present. Pass → patched card.
   Any failure → fall through to full translation.
2. **Full translation** (`_translate_card(stage_id, members, code_dir, skeleton,
   synopses)`): `unit = collect_units(stage_id, members, code_dir)[0]`; cache ladder:
   upstream phase-3 cache → local per-case cache → ONE validated LLM call.
   Prompt = `build_prompt(unit, skeleton, synopses[stage_id], lang="en")` + appended
   STRICT OUTPUT RULES ("the validator REJECTS the reply otherwise"): `schema_version`
   present and exactly 1; every `relations` list (callers, core_callees,
   config_state_sources, results_to) non-empty — use `["(none)"]` when genuinely empty;
   `type` must equal `unit.type_kind`; for `multi_region` units, `regions` must have
   EXACTLY len(entries) items, each with `gloss` and `line_range`, and
   `overall_structure` the same count. Reply: `parsed_json` required (else
   RuntimeError); mechanical normalization of information-free slips
   (`setdefault schema_version=1`; empty relations lists → `["(none)"]`); then
   `validate_translation(unit, translation)` must pass (else RuntimeError);
   `save_cached`; return `render_unit(unit, translation, lang="en")` (markdown card).
   Sibling synopses come from `PRISTINE_HANDBOOK_JSON` (qualname → translation.synopsis
   per stage; empty dict when absent).

*Placement (SERIAL, deterministic)*: per qual in sorted order, per sid in the qual's
order: translation error → record `"{q}@{sid}: translation failed: …"`, mark qual
failed. Else `target = _chapter_file(...) or first file hosting the slug or None`
(None → error "no chapter file for the card"). If target is the sid's OWN chapter,
already holds the slug, and wasn't already placed into this run → replace in place
(regex sub, count=1, `card.rstrip()+"\n"`); else append:
`\n<!-- card placed by resync (stage {sid}) -->\n\n{card}\n`. After placing all of a
qual's cards (no failures): delete same-slug cards from files NOT placed into (chapters
the function no longer belongs to). Record qual into `cards_patched` (if any of its
cards came from the patch path) else `cards_translated`.

*Post passes*: failed quals → `cards_pending` + late anchor pass (old card kept, so its
anchors are rolled now). Patched quals → late anchor pass (patched cards kept the OLD
anchor by contract).

*Registers + index*: if `registers.md` exists →
`bhs._enrich_registers(text, root=code_dir)` (re-grep code sites against the EDITED
tree; idempotent) and rewrite; then `bhs.rebuild_index(hb_dir)`.

**End checks** (mechanical; red is reported, never blocks):
```python
chk = {"sha_mismatch": [...], "entry_without_card": [...], "card_without_entry": [...], "ok": bool}
```
- sha_mismatch: for every mapped member (skipping frozen), the stored sha1 must equal
  the sha of the current text at its line_range (also flags a range beyond EOF).
- Card coverage: `card_quals` = every `<summary><b>(qual)</b>` in stage files
  (regex `<summary><b>([\w.]+)</b>`);
  `entry_without_card = mapped − card_quals − frozen − pending`;
  `card_without_entry = card_quals − mapped − frozen`.
- `ok` = all three lists empty.

**`_reclassify_one`** retained (propose+apply serially) — the seam `rerun_resync.py`
monkeypatches. NOTE: the current driver calls `_classify_propose` directly, so a
replacement of `_reclassify_one` only affects the legacy one-shot path (see 4.8).

### 4.6 `resync_large.py` — file-level engine

For handbooks whose LEAF is a whole FILE (one deep card per file; stages are file
buckets; Phase 3 narrates bottom-up with a content-hash rollup cache). Skeleton (stage
tree) is STABLE across a resync — files roll within existing stages; re-synthesizing the
spine = full rebuild.

Generator resolution: `$HANDBOOK_GEN_ROOT` else `REPO_ROOT/handbook_generate_large`;
sys.path gains `<gen>`, `<gen>/adapters`, `<gen>/phase1`, `<gen>/phase2`, `<gen>/phase3`,
`<gen>/shared`, this dir. Imports: `base` (adapters registry), `build_graph`,
`build_handbook`, `file_assign`, `nav_pack`, `organize_stages`, `read_files`,
`skeleton_yaml` (+ `stage_short_descriptions`), `ir.ModuleAnalysis`; plus `resync_llm`.

**Large-skill layout** (the per-case copy the resync edits):
```
<skill>/phase2/cards/              one JSON card per file (path = <relpath>.json)
<skill>/phase2/skeleton.yaml       stage tree (stable)
<skill>/phase2/file_stage.json     file -> stage buckets
<skill>/phase2/stage_organization.yaml
<skill>/handbook/                  rendered md (+ cache/ — kept for warm rollups)
```

**`resync_large(edited_dir, skill_dir, pristine_dir, *, lang="python",
source_exts=(".py",), narrate_lang="zh", decl=None, report_out=None, workers=None,
build=True, html=False, agent=False, api=None) -> report`**:

Preconditions: `phase2/cards`, `skeleton.yaml`, `file_stage.json` must exist
(FileNotFoundError otherwise). `workers = workers or max(1, int($RESYNC_WORKERS or 4))`.
Report skeleton: `{"scale":"large","lang","narrate_lang","verdicts":{},
"new_unassigned":[],"stages_reorganized":[],"errors":[],"build":{}}`.
Usage ledger → `<report_out.parent>/resync_llm_usage.jsonl`. `api = resync_llm.get_api()`
when not injected.

- **A/B — graph + verdicts.** `build_graph_for(edited_root, lang)`: run large Phase 1 in
  a temp dir — `lang=="auto"`: `base.discover_all` → per-language `get_adapter(lg)
  .analyze(files, root)`, concat functions/edges, `ModuleAnalysis`, `build_graph.build(...,
  lang="multi", default_ext=".py")`; single language: `adapter.discover` → `analyze` →
  `build_graph.build(..., default_ext=adapter.extensions[0])`. Return parsed
  `graph.json`. `edited_files = {f["file"] for f in nav_pack.all_file_descriptors(graph)}`
  (1:1 with cards; scanned_files metadata means function-less files still get cards).
  `known_cards = read_files.load_cards(cards_dir)`; `known_files = set(known_cards)`.
  `detail = _detect_detail(known_cards)`: any card with a `description` or an annotated
  function (`functions[i].purpose`) → `"deep"`; else `"brief"` if any cards else `"deep"`
  — resync must re-read at the SAME granularity (hardcoding deep over a brief-built skill
  would re-read every file on resume and balloon the diff).
  `_verdicts(known, edited, edited_root, pristine_root)`: removed = known−edited (sorted);
  new = edited−known; for the intersection compare sha1 of pristine vs edited bytes —
  identical → unchanged; differing OR pristine missing (drift) → changed. Report:
  `verdicts` (each list truncated to 200 entries + `"...(truncated)"`), `counts` (lens).
- Optional decl reconcile: from graph nodes with `kind=="internal"` build
  qualname→file; `report["declared_files"]` = sorted files of all declared qualnames.
- Nothing changed → `report["note"]="no file-level change detected — nothing to resync"`,
  write report, return.
- **C — cards** (`_refresh_cards`): delete the changed + removed files' cards
  (`cards_dir/<rel>.json`, missing_ok; OSError → report error), `resync_llm.set_phase("read")`,
  `read_files.read_purposes(api, graph, edited_root, cards_dir=…, batch_size=1,
  max_workers=workers, max_chars_per_file=0, detail=detail, resume=True, lang=narrate_lang)`
  — resume re-reads exactly the changed+new files, keeping every unchanged card.
  Record `cards_after = coverage.n_files`, `cards_described = coverage.n_described`.
  Then `file_purposes = read_files.load_cards(cards_dir)`.
- **C — buckets** (`_sync_buckets`): mutate `file_stage.json` doc in place. Ensure a
  bucket per skeleton stage. Removed: pop from `file_stage` map, remove from its stage's
  bucket, mark stage affected. New: `_assign_new_files` — batch classify (batch 25) via
  `file_assign._assign_batch(api, stage_menu, valid_ids, batch, file_purposes)` with
  `resync_llm.set_phase("assign")`; stage menu = `"  - {sid}: {desc}"` lines from
  `stage_short_descriptions(skeleton)`; descriptors from `nav_pack.all_file_descriptors`
  with a default `{"file","dir","n_functions":0,"classes":[],"sample_functions":[]}`
  fallback. Assigned to a valid stage → bucket append + `fs[rel]={"stage",
  "also"}` + affected; else `{"stage":"unassigned","also":[]}` + `new_unassigned`.
  Recompute `coverage = {"n_files","n_assigned","unassigned":[...]}`. Return affected
  stage set. Write file_stage.json (indent 2, ensure_ascii=False).
- **C — organization** (`_sync_organization`): load `stage_organization.yaml`
  (or `{"metadata":{},"stages":{},"coverage":{}}`). For each affected stage (sorted;
  `resync_llm.set_phase("organize")`): bucket empty → drop entry, record emptied;
  gained files (or not yet organized) → `organize_stages._organize_one_stage(api, stage,
  files_now, file_info, adj, narrate_lang)` (LLM; `adj=organize_stages.
  file_call_adjacency(graph)`, `file_info=organize_stages._file_info_map(graph,
  file_purposes)`), record reorganized; only lost files → `_prune_org_stage` — drop the
  removed files from each group's `files` (dropping emptied groups) and from
  `ordered_files`, minimal mechanical edit. Re-key `org["stages"]` in skeleton order;
  recompute `coverage = {"n_files": bucket union size, "n_organized": Σ len(ordered_files)}`.
  Report `stages_reorganized`, `stages_emptied`. Write yaml
  (`sort_keys=False, allow_unicode=True, width=10000`).
- **D — writeback** (when `build`): `resync_llm.set_phase("rollup")`;
  `build_handbook.build(phase2_dir, handbook_dir, api=api, lang=narrate_lang,
  workers=workers, refresh=False, html=html, agent=agent)` — content-hash rollup cache
  warm ⇒ only affected stages re-narrate; unchanged pages come out byte-identical
  (minimal handbook diff). Record `build = {n_stages_summarized, n_files, n_registers,
  out_dir}`; failure → error entry, sync preserved. Then for every emptied stage, unlink
  stale `handbook/{sid}.md`, `handbook/html/{sid}.html`, `handbook/agent/{sid}.md`.
- Write report to `report_out` if given; return.

CLI: `--edited --pristine --skill [--lang] [--narrate-lang en|zh] [--report] [--workers]
[--no-build] [--html] [--agent]`; prints the counts line.

### 4.7 `lang_layer.py` — multi-language substrate

Four language-specific primitives, delegated to the handbook_generate_small adapters
(Python keeps a stdlib-`ast` native path, byte-identical to resync's originals; other
languages ride `get_adapter(lang)`/tree-sitter, loaded LAZILY so Python-only runs never
import tree-sitter). Adapter root: `$HANDBOOK_MULTILANG_ROOT` else
`REPO_ROOT/handbook_generate_small`; `_ensure_adapters()` puts `<small>`,
`<small>/adapters`, `<small>/phase1` on sys.path once (deliberately NOT phase2/phase3 —
names would collide with the member engine's imports).

- `SKIP_DIRS` — dir names skipped when scanning: `.git .hg .svn node_modules vendor
  target build dist out __pycache__ .mypy_cache .pytest_cache .ruff_cache .tox venv
  .venv env .env site-packages .idea .vscode`.
- `ext_of(glob_or_ext)`: `'*.py'→'.py'`, `'.rs'→'.rs'`, `'**/*.py'→'.py'`,
  `'src/*.rs'→'.rs'` (drop dir part; prefix "." before last dot-suffix).
- `spans(path, lang) -> {qualname: (start, end)}` (1-based inclusive). Python
  (`_py_spans`): walk module AST; functions/async functions get
  `prefix+name`, span start = min(def lineno, all decorator linenos), end =
  `end_lineno`; recurse into function bodies with `name.` prefix and class bodies
  with `ClassName.` prefix (dotted `Class.method.inner`). Other languages:
  `get_adapter(lang).analyze([abs_path], abs_path.parent)` →
  `{fn.qualname: (fn.line_start, fn.line_end)}`.
- `syntax_ok(path, lang, src=None) -> bool`: Python `compile(src, name, "exec")`;
  others: `base.parse_tree(lang, src)` with no `"ERROR"` descendant node (parse
  exception → False).
- `body_fingerprint(lines, lang) -> str`: sha1 of `"\n".join(lines[i+1:])` where `i` is
  the first *signature line* (the line opening the definition, carrying the name), so a
  rename with identical body matches. `_is_sig_line`: python — startswith `def `/
  `async def `; rust — contains `fn ` and startswith one of `fn / async fn / pub /
  pub( / const / unsafe / extern / default `; go — startswith `func `; ts/js —
  contains `function`, or contains `=>`, or (identifier-before-paren and endswith `{`).
  No signature recognized → skip just the first line.
- `fresh_graph(code_dir, lang, default_ext) -> {"nodes": {...}, "edges":
  [{"caller_id","callee_id"},...]}`: adapter discover+analyze,
  `build_graph.partition_edges`, `build_graph.build_node_table(functions, kept,
  default_ext)`. ANY failure → `{"nodes": {}, "edges": []}` (classifier degrades to no
  caller/callee context rather than crashing).
- `supported_languages() -> list[str]`: adapters' `available_languages()`; on any
  failure → `["python"]`.

### 4.8 `rerun_resync.py` — resync replay (ablation helper)

Purpose: derive the OTHER translate variant from an already-executed case without any
agent re-run — both variants share the identical code diff and ledger, differing only in
card translation (clean Translate-vs-No-Translate comparison). Classification is
REPLAYED mechanically from the source ledger (zero LLM); only card translation may call
the LLM (content cache first).

CLI: `--src <completed case>` `--dst <output case>` `[--no-translate]`.

Source-case requirements: `edited/`, `mapping.updated.yaml`, and `plan_check.json` OR
`plan.md` (SystemExit listing whatever is missing). Declarations: prefer
`plan_check.json`'s `"declarations"`, else `parse_declarations(plan.md)`.

Replay mechanism: read `mapping.updated.yaml`; build `by_q: {qualname: [(sid, member), …]}`
over function/region members with a line_range. Define
`replay(api, q, span, fname, mapping_doc, skeleton, graph, code_dir)`: unknown q →
False (normal fallback path); else drop q's members from every stage and re-insert its
ledger entries exactly as recorded; return True. Install with
`rh._reclassify_one = replay`. (Note: the current `resync()` driver calls
`_classify_propose` directly, so this seam only bypasses classification on the legacy
one-shot path — a faithful port should preserve the *intended* semantics: replayed
classification, zero LLM.)

Warn (not fail) when translating without `OPENAI_API_KEY`/`LLM_API_KEY`. Prepare dst:
mkdir; if src≠dst copy `edited/` (ignoring `.git`) and any of `plan.md`,
`plan_check.json`, `agent.diff`; snapshot `HANDBOOK_REFS` into `dst/handbook` (local
`_snapshot` = copytree ignoring `.git` + git init/add/commit, same `_GIT` identity).
Run `rh.resync(dst/edited, dst/handbook, PRISTINE, decl,
mapping_out=dst/mapping.updated.yaml, translate_cards=not --no-translate)` where
`PRISTINE = get_target().pristine_root`. Write `resync_report.json`,
`handbook_final.diff`. Print: changed count, cards translated/pending, errors, check ok.

### 4.9 `pipeline/_recon_terminus_base.py` — PHASE2_FINAL reconstruction

Deterministically (zero LLM) rebuild the member-level phase-2 base
(`skeleton.yaml` + `mapping.yaml`) from the rendered skill's `index.md`, which encodes
the stage tree, per-stage members as `` `qualname` (file:start-end) ``, and registers.

Inputs: `INDEX = handbook_skills/handbook_skill_terminus/references/index.md`,
`PRISTINE = REPO_ROOT/harbor/src/harbor/agents/terminus_2`.
Output: `REPO_ROOT/handbook_generate_terminus/work/terminus/phase2/iterations/final/
{skeleton.yaml, mapping.yaml}`.

Parsing (`parse_index`): stage lines `^- \*\*(?P<id>[^*]+)\*\*\s+—\s+(?P<title>.+?)\s*$`;
member refs `` `(?P<qn>[^`]+)`\s*\((?P<file>[^():]+):(?P<a>\d+)-(?P<b>\d+) `` inside a
`- functions:` line; the first other `- ` bullet under a stage is its description;
`## State registers` switches to register mode with lines
`^- \*\*`(?P<id>[^`]+)`\*\*\s+—\s+(?P<sem>.+?)\s*$`.

skeleton.yaml: stages with `{id, title, description|"(no description)", parent, children}`
where parent is derived by stripping a trailing `.N` if the prefix is itself a stage id;
`metadata: {version: 1, generated_from: "index.md (deterministic recon)"}`;
`state_registers: [{id, semantics}]`; `subsystems: []`.

mapping.yaml: `metadata {reconstructed_from, method: "deterministic (zero-LLM)"}`;
per stage `{members: [...], uses_crosscuts: [], subsystem_refs: []}`; each member
`{qualname, type, file, line_range: [a,b], sha1: sha1_of_range(pristine file, a, b),
purpose: ""}` where `type = "function"` if the AST span (`lang_layer.spans`) equals
(a,b) exactly, `"region"` otherwise; qualname absent from AST → warn + default
"function". `unmapped_functions: []`. Prints stage/member/register counts + warnings.

---

## 5. Skill builders (`handbook_skills/`)

### 5.1 `build_skill_from_handbook.py` — generic assembler (any target)

Turns any *rendered handbook directory* into the planner-ready skill layout:

```
handbook_skill_<target>/
├── SKILL.md                      # generated navigation guide (template below)
└── references/
    ├── overview.md               # copied if present
    ├── index.md                  # copied if present
    ├── registers.md              # copied from registers.md OR register.md
    └── stages/<id>.md            # copied stage pages
```

CLI: `[--target T] [--src DIR] [--dest DIR]` (target default `$EVAL_TARGET` or
terminus2; src default `target.handbook_rendered`; dest default `target.handbook_skill`).

`build(target_name, src, dest)`:
1. Resolve src; missing → FileNotFoundError ("Pass --src /path/to/handbook (a dir with
   index.md + stages/)").
2. `rmtree(dest)` if it exists; mkdir `references/stages`.
3. Write `SKILL.md` from the `_SKILL_MD` template with `{name}` = target name and
   `{project}` = `prompt_vars["PROJECT"]` (fallback name). Template (verbatim intent):
   YAML frontmatter `name: {name}-handbook` and a description "A navigation index for
   the {project} codebase. Use it to locate every file/function/site a change must touch
   before reading the real source."; body titled "# {project} Handbook — how to use it"
   stating it's a **location index**, then 5 numbered steps: read
   `references/overview.md`; read `references/index.md` (stage index mapping subsystems
   to files); open relevant `references/stages/<id>.md`; check `references/registers.md`
   for cross-cutting state ("invaluable for fan-out changes"); then `read_file` the
   actual source. Ends: "Do NOT treat the handbook as ground truth for code text —
   always confirm against the real source before emitting a verbatim edit."
4. Canonical reference copy map (first existing candidate wins):
   `overview.md ← [overview.md]`, `index.md ← [index.md]`,
   `registers.md ← [registers.md, register.md]`.
5. Stage pages: if `src/stages/` is a dir copy `stages/*.md` (sorted); else FLAT layout
   (what handbook_generate_large emits) — copy `src/stage-*.md` (sorted). Either way
   into `references/stages/`.
6. Print `built <dest>  (refs: … | N stage pages)`; return dest.

### 5.2 `build_handbook_skill.py` — Terminus-2-specific carver + register enrichment

Generates the skill's references by **carving the fully-rendered handbook markdown**
(`handbook_en.md` — same source as the HTML viewer; every function card carries its
`file.py:start-end` anchor, typed parameter list, formatted signature, and a
`**Source**` block with real code). The old JSON→md path is dead (it silently dropped
parameter types). Pure stdlib.

Inputs: `HANDBOOK_MD` = `$HANDBOOK_MD` else first existing of
`<Harness_Translation>/handbook/phase3/output/handbook_en.md`,
`REPO_ROOT/handbook_generate/phase3/output/handbook_en.md`,
`REPO_ROOT/handbook/phase3/output/handbook_en.md`.
`PRISTINE` = `$PRISTINE_ROOT` else the terminus_2 source (for register enrichment;
missing source files just leave "(none)" site lists).
Output: `handbook_skills/handbook_skill_terminus/references/` (recreated fresh):
`overview.md`, `index.md`, `registers.md`, `stages/<id>.md`.

**Chapter carving** (`_split_chapters`): a chapter starts at any h2
(`^## (.+?)\s*$`) or at a *numbered sub-stage* h3 (`^### (\d+\.\d+) · (.+?)\s*$` —
other h3s like "### Relations" stay inside). Code-fence tracking: toggling on lines
whose lstrip startswith ``` so a col-0 `## comment` inside a Source block is not a
chapter. Chapter id mapping (`_chapter_id`): heading containing "System Overview" →
`("overview", …)`; containing "State Flow Reference" → `("registers", …)`;
`(\d+(?:\.\d+)?) · Title` → `("stage-<num>", Title)`;
`((?:side|crosscut|subsys)-[\w-]+) · Title` → `(<that id>, Title)`; else skipped.
Content per chapter = its heading line through just before the next start, verbatim
(cards, Source blocks and all).

**Register enrichment** (`_enrich_registers(text, root=None, reg_map=None) ->
(text, n)`) — also the post-edit RESYNC primitive (idempotent; pointed at an EDITED tree
it refreshes every block to post-change line numbers):
1. Strip any prior `<!-- code-sites:start --> … <!-- code-sites:end -->` injection.
2. For each `### ` header containing a `` `reg-…` `` id, inject below it:
   ```
   <!-- code-sites:start -->
   **Code sites (authoritative — exact lines grepped from the source):**
   - Init (in __init__): …           (or "(none)")
   - Reset (in _reset_per_run_state): …
   - Other writes: …
   - Reads: …
   <!-- code-sites:end -->
   ```
   with each item rendered as ``  - `file.py:LINE  (`method`)` ``.
3. Site classification (`_sites(pattern, root)`): grep `SOURCES =
   ["terminus_2.py", "terminus_json_plain_parser.py", "terminus_xml_plain_parser.py",
   "tmux_session.py"]` under root (default pristine) for the register's attribute regex
   (`REG` maps 10 register ids like `reg-pending-completion` →
   `r"self\._pending_completion\b"`, `reg-chat-messages` →
   `r"chat\.(?:_messages|messages)\b"`, etc.). A hit is a **write** when the text after
   the match matches `_ASSIGN` (optional subscripts then any augmented/plain assignment,
   `(?!=)` excluding `==`) or `_MUT` (`.append/.pop/.clear/.extend/.insert/.remove/
   .sort/.update/.add/.setdefault/.discard(`). Enclosing function via `_methods`:
   4-space-indent `def` = class method; col-0 `def` = module function; col-0 `class`
   resets to None. Writes in `__init__` → Init; writes in `_reset_per_run_state` →
   Reset; other writes → Other writes; non-writes → Reads.

**index.md rendering** (`_render_index`): header "# Terminus-2 Handbook — Index",
"Use this to decide which reference file(s) to open.", section
"## Stages (each detailed in `stages/<id>.md`)" with per stage:
```
- **<cid>** — <title>
    - <blurb>
    - functions: `Qual.name` (file.py:a-b), `Other` (…)
```
then "## State registers (each detailed in `registers.md`)" with
`- **`reg-…`** — <purpose>` lines. Function cards extracted with
`_CARD = <summary><b>([^<]+)</b>\s*—\s*([^·<]+?)\s*·\s*([^<]*)</summary>` (qualname,
anchor, role). Register purposes extracted from `### `-split blocks: name = first
backticked token on the header line, purpose = `**Purpose**:` line.

**Blurb truncation rule** (`_stage_blurb(content, max_chars=900)`): take the stage's
"Opening Explanation" section (regex up to the next heading), collapse whitespace to
single spaces; if > 900 chars cut at 900 then back to the last `". "` sentence boundary
(+"."). Purpose: enough to ROUTE a query; function detail stays in the stage page.

**`rebuild_index(refs_root, insert_after=None) -> bool`** — regenerate an EXISTING
references dir's index.md from its current files: stage order/titles parsed from the old
index (`^- \*\*([A-Za-z0-9.\-]+)\*\* — (.+)$` — register lines have backticks so they
don't match); stage files on disk unknown to the old index get their title from their own
chapter heading and are inserted after `insert_after[new_id]` (or appended); blurbs,
function lists (with anchors) and register list re-extracted fresh. Returns False when
index.md/registers.md missing or no entries. Used by resync's phase D.

`main()`: carve chapters; write overview/registers(enriched)/stages; build index; print
counts (stages, function cards, registers, code-sites enriched, total KB).

---

## 6. The `build-codebase-handbook` skill

An agent skill directory (Apache-2.0 LICENSE included so a detached ZIP stays licensed):

```
build-codebase-handbook/
├── SKILL.md
├── LICENSE
├── agents/openai.yaml
├── references/handbook-format.md
└── scripts/{inventory.py, compile_coverage.py, validate_handbook.py, package_skill.py}
```

### 6.1 `SKILL.md` — the workflow

Frontmatter: `name: build-codebase-handbook`; description states use/do-not-use triggers
(generate/refresh/validate/use a planner-ready handbook; map or document a codebase;
NOT for ordinary code changes, non-code research, API docs lookup, isolated known-file
edits) and "Performs reasoning in the active Codex session and never requires an
external LLM API key."

Workflow (functional content):

- **Choose the workflow.** Resolve the skill dir as `HANDBOOK_BUILDER_ROOT`. Modes:
  *Task mode* (use an existing handbook to route a concrete task), *Build mode*
  (generate/refresh/validate), *Combined*. Never generate a handbook merely because a
  coding task mentions a repository.
- **Task mode steps**: (1) resolve the handbook (user-named, else inspect
  `<source>/.agents/skills/*-handbook/SKILL.md` excluding this builder; choose by repo
  name/scope; ask only when ambiguity materially matters); (2) read its SKILL.md fully,
  then overview.md, route through index.md, load only relevant stage pages +
  registers.md; (3) inspect `references/coverage.json` for freshness; optionally run the
  validator — validation failures are drift signals, not permission to skip the task;
  (4) read the real source at every cited path/symbol; search for callers/tests/config/
  state readers-writers changed since generation; (5) respect the action boundary
  (read-only for explanation/diagnosis/planning/review; implement+verify for requested
  changes; broad changes use index+registers as a coverage checklist); (6) refresh only
  when asked/required, else report stale hashes. "Never treat handbook prose as
  authoritative code text."
- **Build mode — scope**: source root = requested repo else current; output = requested
  path else `<source>/.agents/skills/<repository-slug>-handbook`; work dir = temp dir
  outside the output; language = requested else English. Scripts need Python ≥3.10,
  stdlib only (no requirements.txt by design). The generated folder must be
  independently shareable (no imports from source repo or builder; no README/build
  log/scratch/source snapshot). Existing output: update in place, preserve hand-written
  content, never delete the folder wholesale.
- **Step 1 — inventory before interpreting**: read AGENTS.md/repo instructions first;
  run `inventory.py --source-root <source> --output <work>/inventory.json`; review
  summary + skip reasons; add `--exclude PATTERN` for generated trees; never weaken
  secret/private-key exclusions. The inventory is the **coverage contract** — no silent
  omission of eligible files.
- **Step 2 — derive the behavioral map**: inspect actual source in bounded batches;
  identify (1) entry points/external inputs, (2) ordered runtime/build stages, (3) core
  domain logic/orchestration, (4) state/config/persistence/queues/caches (registers),
  (5) boundaries (APIs/CLIs/DBs/providers/subprocesses), (6) error/retry/cancellation/
  cleanup/shutdown paths, (7) contract-bearing tests. Group by behavior and lifecycle,
  not directories; prefer **4–12 stages**; each file gets ONE primary stage. Large repos:
  analyze independent inventory slices with subagents (facts with exact paths/symbols;
  reconcile against source yourself) else sequentially.
- **Step 3 — write the generated skill**: read handbook-format.md completely first;
  create `<output>/SKILL.md`, `agents/openai.yaml`, `references/{overview.md, index.md,
  registers.md, stage-rules.json, coverage.json, stages/<stage-id>.md}`. Exact
  repo-relative paths and symbol names; summarize behavior, never copy source bodies;
  never include credentials/env values/private keys/secrets. The generated SKILL.md must
  tell future agents to route with the handbook then inspect real source; the handbook
  is not ground truth for verbatim code.
- **Step 4 — compile complete coverage**: express primary file→stage assignment in
  `references/stage-rules.json` (narrow, non-overlapping globs; exact-path overrides for
  exceptions); run `compile_coverage.py --inventory … --rules … --output
  <output>/references/coverage.json`; fix unmatched files, overlapping rules, unknown
  overrides, invalid stage IDs; no catch-all rule to conceal incomplete analysis.
- **Step 5 — validate and reconcile**: run `validate_handbook.py --source-root <source>
  --skill-dir <output>`; resolve every error; review warnings. Then: every stage page
  linked from index.md; spot-check paths/symbols/lifecycle order/register claims; review
  the diff for accidental source excerpts or sensitive info; report output path,
  eligible-file coverage, validation result, intentionally skipped categories.
- **Refresh**: re-run inventory + validator first; stale hashes and new/deleted paths
  identify affected stages; re-read changed source; update those stage pages; roll
  upward into registers.md, index.md, overview.md; recompile coverage; validate again.
  Don't rewrite unaffected prose for style.
- **Packaging**: `package_skill.py --output <dest>/build-codebase-handbook.zip` —
  deterministic archive, one top-level `build-codebase-handbook/` dir, excludes caches/
  temp/archives/VCS metadata, auto-includes requirements.txt if present. License caveat
  for generated handbooks (owner's license, not necessarily Apache).

### 6.2 `references/handbook-format.md` — the canonical generated-handbook format

**Design rules**: standalone skill, no builder dependency; repo-relative POSIX paths even
on Windows; exact symbol names + concise factual summaries; route with the handbook but
verify real source before planning/editing; do not copy complete functions/files/prompts/
credentials/env values; keep each fact in the narrowest useful page and link upward
instead of duplicating.

**Generated `SKILL.md`**: frontmatter with ONLY `name` and `description`; name =
`<repository-slug>-handbook`; description carries positive AND negative triggers
(canonical template):

```yaml
---
name: <repository-slug>-handbook
description: Navigate the <Project> repository by behavior and source location. Use when planning, implementing, debugging, testing, explaining, or reviewing <Project> work that is unfamiliar, spans multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to <Project>, requests without access to its source, or isolated edits where the exact file is already known and no cross-cutting impact is plausible.
---
```

Body must tell the agent to: (1) read `references/overview.md` for system shape;
(2) route through `references/index.md`; (3) read relevant
`references/stages/<stage-id>.md` pages; (4) check `references/registers.md` for
cross-cutting state; (5) read actual source at cited paths before proposing/making
changes; (6) treat `references/coverage.json` hashes as freshness signals, not source
truth; (7) respect the task boundary (read-only for explanation/diagnosis/plans/reviews;
edit and test only when a change is requested).

**Generated `agents/openai.yaml`** (all values quoted; short_description 25–64 chars):
```yaml
interface:
  display_name: "<Project> Handbook"
  short_description: "Navigate the <Project> codebase by behavior"
  default_prompt: "Use $<repository-slug>-handbook to locate the source involved in this change."
```

**`references/overview.md`** must include: purpose and system boundary; component map;
end-to-end execution/build lifecycle; entry points and external interfaces; major
extension points; build/test/verification commands when repo-evidenced; a freshness note
pointing at coverage.json. Compact flow diagram only when clarifying a ≥3-stage sequence.

**`references/index.md`** starts with a routing table:
```
| Stage | Responsibility | Primary inputs | Primary outputs | Page |
|---|---|---|---|---|
```
followed by change-routing hints (task type → stage), cross-stage relationships, and a
link to registers.md. **Every page in `references/stages/` must be linked exactly once
from the routing table.**

**`references/registers.md`** documents cross-cutting state/config/durable data:
```
| Register | Owner | Initialized | Written | Read | Invariants |
|---|---|---|---|---|---|
```
Exact `path:symbol` locations; include error/cancellation state affecting multiple
stages; if no meaningful registers, say so and list the configuration sources that
shape execution.

**Stage pages**: stable lowercase IDs (`stage-1-entry.md`, `stage-storage.md`). Each page
must contain, in order: (1) purpose and boundaries; (2) files and key symbols table
`| File | Key symbols | Role |`; (3) control and data flow; (4) inputs, outputs,
external interfaces; (5) state mutations and invariants; (6) failure/retry/cancellation/
cleanup behavior; (7) tests and verification; (8) change-routing notes. Shared files may
be mentioned on other pages, but each eligible file has exactly one primary stage in
coverage.json.

**`references/stage-rules.json`** (source-controlled assignment definition):
```json
{
  "schema_version": 1,
  "stages": [
    {"id": "stage-entry", "include": ["src/cli/**", "src/main.py"]},
    {"id": "stage-runtime", "include": ["src/runtime/**"], "exclude": ["src/runtime/adapters/**"]},
    {"id": "stage-adapters", "include": ["src/runtime/adapters/**"]}
  ],
  "overrides": {"tests/test_cli.py": "stage-entry"}
}
```
Rules must be non-overlapping after exclusions; exact-path overrides take precedence;
every stage ID must have a matching `references/stages/<id>.md`.

**`references/coverage.json`**: never hand-edited; generated by compile_coverage.py;
records the inventory fingerprint plus each eligible file's primary stage, language,
line count, size, and content hash; the validator uses it to find omissions and stale
pages.

### 6.3 `scripts/inventory.py`

Deterministic, content-safe repository inventory: paths, sizes, line counts, language
hints, SHA-256 hashes — never file contents; excludes secrets/generated/deps/binaries
by default. `SCHEMA_VERSION = 1`.

CLI: `--source-root (default cwd)`, `--output` (stdout if omitted), `--exclude GLOB`
(repeatable, repo-relative), `--max-bytes` (default 2_000_000). Exit 2 on ValueError
(non-directory root). Stderr summary: "N eligible files, N lines, N skipped".

`scan(source_root, extra_excludes=(), max_bytes=2_000_000) -> dict` walking
`os.walk(topdown=True, followlinks=False)` with sorted dirs/files:

- Directory pruning (recorded in `skipped` with a trailing `/`):
  `DEFAULT_EXCLUDED_DIRS` = `.git .hg .svn .idea .vscode .venv venv __pycache__
  node_modules vendor dist build coverage .coverage .pytest_cache .mypy_cache
  .ruff_cache .tox .next .nuxt .turbo .cache target` → reason `excluded-directory`;
  glob-matched dirs (pattern tested against `rel/` and `rel/_`) → `excluded-pattern`;
  symlinked dirs → `symlink-directory`.
- Default excluded globs: `.agents/skills/*-handbook/**`, `.handbook-work/**`, `*.pyc`,
  `*.pyo`, `*.class`, `*.o`, `*.obj`, `*.so`, `*.dylib`, `*.dll`, `*.exe`, `*.min.js`,
  `*.min.css`, `*.map`, `*.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `Cargo.lock`, `poetry.lock`, `Pipfile.lock` (+ user `--exclude`; `fnmatch.fnmatchcase`).
- Per-file skip order & reasons: symlink → `symlink`; sensitive → `sensitive`
  (name-lowercased in `SENSITIVE_NAMES` = `.env .env.local .env.production
  .env.development credentials credentials.json secrets.json secrets.yaml secrets.yml
  id_rsa id_dsa id_ecdsa id_ed25519`, or rel path lowercase matching `SENSITIVE_GLOBS` =
  `.env.* *.pem *.key *.p12 *.pfx *.jks *.keystore *credentials*.json *secret*.json`);
  glob match → `excluded-pattern`; stat error → `stat-error:<ExcName>`; size >
  max_bytes → `oversize` (+bytes); read error → `read-error:<ExcName>`; binary →
  `binary` (+bytes). Binary heuristic `_looks_binary`: NUL in first 8192 bytes, or >10%
  of the first 8192 bytes are control chars (`<9` or `13<b<32`).
- Language detection: `SPECIAL_NAMES` (Dockerfile/Makefile/Rakefile/Gemfile/
  CMakeLists.txt/Justfile/Procfile) first, else `LANGUAGES[suffix.lower()]` (a ~60-entry
  ext→language table: .py/.pyi Python, .rs Rust, .go Go, .js/.jsx/.mjs/.cjs JavaScript,
  .ts/.tsx TypeScript, .java, .kt/.kts Kotlin, .c/.h/.cc/.cpp/.cxx/.hpp C/C++ (with .c "C"),
  .cs, .rb, .php, .swift, .scala, shells, .ps1, .sql, .proto, .graphql/.gql, web
  (.html/.css/.scss/.sass/.less/.vue/.svelte), docs (.md/.mdx/.rst/.txt), data
  (.json/.jsonc/.yaml/.yml/.toml/.xml/.ini/.cfg/.conf/.properties), .gradle, .cmake,
  .dockerfile), else `"Other text"`.
- Eligible file record: `{"path": <posix rel>, "language", "bytes", "lines":
  len(data.splitlines()), "sha256": hex sha256 of bytes}`.
- Output object:
  ```json
  {
    "schema_version": 1,
    "source_root": "<abs>",
    "inventory_sha256": "<sha256 of canonical files JSON (sort_keys, compact separators)>",
    "summary": {"eligible_files": N, "eligible_lines": N, "eligible_bytes": N,
                 "skipped_paths": N, "languages": {"Python": N, ...}},
    "files": [ ...sorted by path... ],
    "skipped": [ {"path", "reason"[, "bytes"]} ...sorted by path... ]
  }
  ```

### 6.4 `scripts/compile_coverage.py`

CLI: `--inventory --rules --output` (all required). Exit 2 with `compile-coverage:
error: <msg>` on any ValueError. Stage-ID regex: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.

Rule validation (`_validate_rules`): `schema_version` must be 1; `stages` a non-empty
array of objects; each stage: valid `id` (regex), unique, `include` a non-empty array of
non-empty strings, `exclude` an array of strings (default []); `overrides` an object of
non-empty relative path (no leading `/`; backslashes normalized to `/`) → known stage id.

`compile_coverage(inventory, rule_data)`:
- inventory must have `schema_version == 1` and a `files` list.
- Overrides referencing paths absent from the inventory → error listing them.
- Per inventory file: overridden path → its stage. Else `matches = [stage.id for stage
  if fnmatchcase(path, any include) and not fnmatchcase(path, any exclude)]`; zero
  matches → collected as unmatched; >1 → collected as ambiguous. Any unmatched or
  ambiguous → single ValueError listing up to 50 of each ("unmatched files:" /
  "files matching multiple stages:" with "... and N more").
- Assignment record: `{"path", "stage", "language" (default "Other text"),
  "lines" (default 0), "bytes" (default 0), "sha256" (default "")}` — copied from the
  inventory entry. Sorted by path.
- Output:
  ```json
  {
    "schema_version": 1,
    "source_root": ".",                      // deliberately portable, no abs path leak
    "inventory_sha256": "<from inventory>",
    "coverage_sha256": "<sha256 of canonical assignments JSON>",
    "summary": {"eligible_files": N, "eligible_lines": N,
                 "stages": {"<id>": <file count>, ...}},   // every rule stage, even 0
    "files": [ ...assignments... ],
    "skipped": <inventory.skipped passthrough>
  }
  ```

### 6.5 `scripts/validate_handbook.py` — what makes a handbook valid

CLI: `--source-root --skill-dir` required; `--exclude GLOB` repeatable (same semantics as
inventory). Warnings → stderr `validate-handbook: warning: …`. Any error → each on
stderr as `validate-handbook: error: …`, exit 2; else print `validate-handbook: OK`,
exit 0. Imports `compile_coverage.compile_coverage` and `inventory.scan` directly
(re-scans the live source).

Checks (errors unless noted):

*SKILL.md* (`_check_skill_md`): readable; YAML frontmatter delimited by `---\n…\n---\n`
at file start (regex `\A---\n(.*?)\n---\n` dotall); parsed as simple `key: value` lines
(non-`key: value` non-blank lines are errors); the field set must be exactly
`{name, description}`; name matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`; description non-empty
AND (lowercased) containing both `"use when"` and `"do not use"`; the SKILL body must
contain the literal `references/index.md` and (case-insensitive) `actual source`.

*agents/openai.yaml* (`_check_openai_yaml`; skipped entirely if unreadable): must
contain the literal tokens `interface:`, `display_name:`, `short_description:`,
`default_prompt:`; `short_description` must be a quoted string on its own indented line
(regex `^\s+short_description:\s+"([^"]*)"\s*$` multiline) of length 25–64; the text
must contain `$<skill name>` (default_prompt must mention the generated skill).

*Required files*: `agents/openai.yaml`, `references/overview.md`, `references/index.md`,
`references/registers.md`, `references/stage-rules.json`, `references/coverage.json` all
regular files; `references/stages/` a directory.

*Schema versions*: coverage.json and stage-rules.json `schema_version == 1`.

*Freshness & coverage computation*: `current = scan(source_root, excludes)` (a scan
failure is a terminal error); `expected_coverage = compile_coverage(current, rules)`
(failure → error "cannot compile current stage rules"). Then, comparing coverage.json's
`files` against the fresh scan:
- coverage `files` must be an array of objects with string paths; duplicate paths →
  error listing them.
- `missing` = eligible files present in the scan but absent from coverage → error
  ("eligible files missing from coverage", first 50).
- `deleted` = coverage paths absent from the scan → error ("coverage contains deleted or
  excluded files").
- `stale` = shared paths whose scan sha256 ≠ coverage sha256 → error
  ("coverage hashes are stale").
- Stage-ID consistency: `{rule stage ids} == {stage ids used in coverage files}` else
  error; `{stages/*.md page stems} == {rule stage ids}` else error.
- index.md must contain the substring `stages/<id>.md` **exactly once** per stage id
  (count over the raw text) else error per id.
- `coverage.summary.eligible_files == len(unique coverage paths)` else error.
- `coverage.inventory_sha256 == current.inventory_sha256` else error
  ("coverage inventory fingerprint is stale").
- `coverage.coverage_sha256 == expected_coverage.coverage_sha256` else error
  ("coverage assignments differ from current stage rules").

*Warning*: if the fresh scan skipped any paths — "N paths were intentionally skipped;
review coverage.json skipped reasons before sharing".

### 6.6 `scripts/package_skill.py`

Deterministic ZIP of the builder skill. CLI: `--output *.zip` (required; suffix
enforced), `--force` to replace an existing archive. Exit 2 with `package-skill:
error: …` on failure; on success prints the path + file count and
`package-skill: content-sha256 <hex>`.

- `REQUIRED_FILES` = SKILL.md, LICENSE, agents/openai.yaml,
  references/handbook-format.md, scripts/{compile_coverage,inventory,package_skill,
  validate_handbook}.py — all must exist (error listing missing).
- Collect: rglob everything under the skill root; skip paths with any part in
  `{.git,.hg,.svn,__pycache__,.pytest_cache,.mypy_cache,.ruff_cache}`; **refuse
  symlinks** (error); skip non-files and suffixes `{.pyc,.pyo,.zip,.tmp}`; sort by
  posix relpath.
- Write to `<output>.tmp` then atomic `replace`; on exception unlink tmp and re-raise.
  Every entry: archive path `f"{root.name}/{relative}"` (single top-level dir), fixed
  timestamp `(1980,1,1,0,0,0)`, `create_system=3`, `external_attr=0o100644 << 16`,
  ZIP_DEFLATED level 9. Content hash: sha256 over `archive_path\0data` per file in order.

### 6.7 `agents/openai.yaml` (the builder's own)

```yaml
interface:
  display_name: "Build or Use Codebase Handbook"
  short_description: "Build or use an API-key-free codebase map"
  default_prompt: "Use $build-codebase-handbook to build or use a planner-ready handbook for this repository task."
```

---

## 7. Environment variables (complete list)

| Var | Used by | Meaning / default |
|---|---|---|
| `OPENAI_API_KEY` | planner, resync | API key (required; `EMPTY` for keyless local) |
| `OPENAI_MODEL` | planner, resync | model (default `gpt-4o-mini`) |
| `OPENAI_BASE_URL` | planner, resync | endpoint (default `https://api.openai.com/v1`) |
| `LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY` | planner, resync | lower-level overrides; win over `OPENAI_*` |
| `NEXAU_CODE_AGENT_DIR` | planner | path to NexAU `examples/code_agent` |
| `EVAL_TARGET` | all | active target (`terminus2` default) |
| `PRISTINE_ROOT` | all | override pristine source root |
| `GOLDEN` | targets | override golden suite path |
| `HANDBOOK_SKILL_DIR` / `HANDBOOK_RENDERED_DIR` | skill build, planner | override built-skill / rendered-handbook dirs |
| `NEXAU_TOOL_CALL_MODE` | planner | `xml` / `structured` (default yaml's) |
| `LLM_TEMPERATURE` | planner | default `0.0` |
| `LLM_NO_TEMPERATURE` | planner | drop temperature param entirely |
| `LLM_MAX_TOKENS` / `LLM_MAX_CONTEXT` / `LLM_MAX_ITERATIONS` | planner | output tokens / context budget (200000) / tool iterations (300) |
| `TOOL_OUTPUT_LIMIT` | planner | LongToolOutput max chars (300000) |
| `LLM_EXTRA_BODY` | planner, resync | raw JSON merged into request bodies |
| `LLM_CACHE_TTL` | planner | cache_control_ttl (default `1h`; `""` off) |
| `LLM_API_TYPE` | planner | e.g. `anthropic_chat_completion` |
| `SANDBOX_WORK_DIR` | planner (set by run_query) | NexAU file-tool root |
| `HANDBOOK_GEN_SCALE` | resync | `large`/`big` → file-level engine; `small`/`member` → member |
| `HANDBOOK_GEN_ROOT` | resync | explicit generator path |
| `HANDBOOK_MULTILANG_ROOT` | lang_layer | small-pipeline adapter root |
| `PHASE2_FINAL` | member resync | mapping/skeleton dir |
| `HANDBOOK_REFS` | member resync | handbook references dir to edit |
| `HANDBOOK_LARGE_SKILL` | file resync | large skill dir to edit |
| `HANDBOOK_MD` | terminus skill builder | rendered handbook md path |
| `RESYNC_TRANSLATE` | member resync | `0/false/off` skips card translation |
| `RESYNC_NARRATE_LANG` | file resync | `en`/`zh` prose (default `zh`) |
| `RESYNC_WORKERS` | both resyncs | thread pool size (member default 1, large default 4) |
| `RESYNC_MINIMAL_PATCH` | member resync | `0/false/off` disables the card-patch path |
| `EVAL_SYNTAX_CMD` | targets | overrides `syntax_command` |

---

## 8. All file/JSON formats (consolidated)

1. **Plan declarations** (last will_* ```json block in plan.md):
   `{"will_modify": [qualname…], "will_add": […], "will_remove": […]}`.
2. **plan_check.json**: `{"declarations": <decl>, "ok": bool, "errors": [str…]}`.
3. **mapping.yaml** (phase-2 ledger): `{metadata: {...}, stages: {<sid>: {members:
   [{qualname, type: "function"|"region", file, line_range: [a,b], sha1, purpose}],
   uses_crosscuts: [], subsystem_refs: []}}, unmapped_functions: [{qualname, file,
   reason}]}`. Resync stamps `metadata.resynced_by = "handbook_as_helper_v2"`.
4. **skeleton.yaml**: `{metadata, stages: [{id, title, description, parent,
   children}], state_registers: [{id, semantics}], subsystems: []}`.
5. **Member resync report (resync_report.json)**: keys `verdicts`
   (qualname → unchanged|changed|gone|renamed|unparsable), `missed`, `unplanned`,
   `renamed` (`"old -> new"`), `removed`, `new`, `unassigned`, `anchors_refreshed` (int),
   `cards_translated`, `cards_patched`, `cards_deleted`, `cards_pending`,
   `repaired_files`, `frozen_files`, `errors`, `check` = `{sha_mismatch,
   entry_without_card, card_without_entry, ok}`. Fatal failure: `{"fatal": "<repr>"}`.
6. **Large resync report**: `{scale: "large", lang, narrate_lang, detail, verdicts:
   {unchanged, changed, removed, new (each ≤200 + truncation marker)}, counts,
   declared_files?, note?, cards_after, cards_described, new_unassigned,
   stages_reorganized, stages_emptied, errors, build: {n_stages_summarized, n_files,
   n_registers, out_dir}}`.
7. **resync_llm_usage.jsonl**: one JSON per line — `{"phase": classify|translate|patch|
   read|assign|organize|rollup|unknown, "model", "in", "out"[, "cached"]}`.
8. **handbook_final.diff / agent.diff**: unified git diff (`git diff --cached` vs the
   "pristine" baseline commit).
9. **planner trace** (`<case>/planner_trace.json`): array of NexAU message dumps
   (every tool call + result), pretty JSON.
10. **Handbook function card** (member-level rendered format):
    ```html
    <details id="<slug>">
    <summary><b>Qual.name</b> — file.py:START-END · one-line role</summary>
    …body: What/Interface/Execution flow/Design decisions/Source…
    **Relations**
    - **Callers** …
    - **Core callees** …
    - **Config / state sources** …
    - **Results to** …
    </details>
    ```
    Navigation-only copy = `<details>`+`<summary>` (+Relations when keep_rel) only.
11. **index.md (member handbook)**: `# … — Index`; `## Stages (each detailed in
    \`stages/<id>.md\`)`; per stage `- **<cid>** — <title>` / `    - <blurb ≤900 chars>` /
    `` - functions: `qual` (file:a-b), … ``; `## State registers (each detailed in
    \`registers.md\`)`; `- **\`reg-…\`** — purpose`.
12. **registers.md code-sites block**: `<!-- code-sites:start -->` …
    `**Code sites (authoritative — exact lines grepped from the source):**` with
    Init/Reset/Other writes/Reads bullet groups of `` `file.py:LINE  (`method`)` `` …
    `<!-- code-sites:end -->` (idempotent, regenerable).
13. **Card translation JSON** (phase-3 contract enforced by validate_translation):
    `schema_version: 1`; `type` == unit.type_kind; `relations` with four non-empty lists
    (`["(none)"]` sentinel); multi_region: `regions` (one per source region, each with
    `gloss` + `line_range`) and matching `overall_structure` counts.
14. **Large-skill phase2**: `cards/<relpath>.json` (per-file card; deep cards carry
    `description` and per-function `purpose`), `skeleton.yaml`, `file_stage.json` =
    `{file_stage: {<rel>: {stage, also: []}}, buckets: {<sid>: [rel…]},
    coverage: {n_files, n_assigned, unassigned: [...]}}`,
    `stage_organization.yaml` = `{metadata, stages: {<sid>: {groups: [{…, files: […]}],
    ordered_files: […]}}, coverage: {n_files, n_organized}}`.
15. **inventory.json** — see §6.3. 16. **stage-rules.json** — see §6.2/6.4.
17. **coverage.json** — see §6.4. 18. **Skill ZIP** — see §6.6.
19. **Skill layouts**: planner skill = `SKILL.md` + `references/{overview.md, index.md,
    registers.md, stages/<id>.md}` (+ optional `disambiguation.md`); generated
    build-mode handbook adds `agents/openai.yaml`, `references/stage-rules.json`,
    `references/coverage.json`.

---

## 9. Re-implementation notes (TypeScript)

- Everything mechanical is regex/hash/AST/file-IO — portable. The AST parts need a
  tree-sitter (or per-language parser) equivalent to `lang_layer`'s four primitives:
  `spans`, `syntax_ok`, `body_fingerprint`, `fresh_graph`. Python's dotted-qualname
  convention (`Class.method.inner`, decorators included in span start) must be
  reproduced exactly for a Python target.
- Hashes: sha1 over UTF-8 of `"\n".join(lines[a-1:b])` for span/sha checks; sha256 for
  inventory/coverage; canonical JSON = `sort_keys`, separators `(",", ":")`.
- Determinism guarantees to preserve: serial mapping write-back in original target order
  regardless of worker count; serial deterministic card placement; per-case caches;
  atomic tmp+rename builds; the directory-mkdir lock; fixed-timestamp ZIP entries.
- Error philosophy: freeze-not-crash (bad files reported, entries untouched); resync
  failure writes `{"fatal": …}` and never loses the run; accounting/telemetry never
  throws; validation is red-flagged in reports but non-blocking (except the skill
  validator, which exits 2).

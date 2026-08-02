# Functional Specification — `handbook_generate_small` (skeleton-driven handbook pipeline)

Source analyzed: `/Users/jack/Desktop/share/Harness_Handbook/handbook_generate_small/` (every `.py` file + README.md).
Purpose of this document: a complete, implementation-grade functional spec sufficient to re-implement the pipeline in TypeScript.

---

## 0. Big picture

A project-agnostic, three-phase pipeline that turns a codebase into a "handbook":

```
Phase 1  run_phase1.py            source files ──(LanguageAdapter → IR)──► phase1/graph.json (+ functions.csv, graph.dot, dropped_calls.json)   [no LLM]
Phase 2  phase2/iterate_phase2.py graph.json + user-authored skeleton.yaml ──(Critic-Actor iteration)──► phase2/mapping.yaml + iterations/final/  [LLM]
Phase 3  phase3/assemble_doc.py   final mapping + skeleton ──(actor-critic-reflexion, tiered)──► phase3/output/handbook*.{json,md}                 [LLM]
```

- **Phase 1** is pure static analysis. Per-language adapters (Python via stdlib `ast`; Rust/TS/Go via tree-sitter; Starlark/Shell/PowerShell via lightweight tree-sitter free-function model) emit a shared language-agnostic IR; a single `build_graph.build()` assembles/writes the four artifacts identically across languages.
- **Phase 2** classifies every internal function into stages of a hand-written "skeleton" (lifecycle description). It's a convergence loop of four LLM passes (C→A→B→D) plus mechanical post-passes and an ordering step, each proposal gated by LLM Critics.
- **Phase 3** narrates: Tier 1 (novice overview), Tier 2 (per-stage prose), Tier 3 (per-function structured JSON translation), plus a register appendix — each Tier unit going through a generate→score→reflect→revise loop with deterministic rubric-based gating; then rendered to markdown/HTML.
- **Project identity** (name/brief/kind) is injected via env vars (`HANDBOOK_PROJECT_*`, set from `--project-*` CLI flags) and read by `project_context.py`, so no prompt hardcodes any project.

Language of the handbook output: `zh` (default) or `en`.

Dependencies: `tree-sitter`, `tree-sitter-language-pack`, `pyyaml`, `requests`; `markdown` + `pygments` only for HTML rendering.

---

## 1. CLI surface

### 1.1 `run.py` — end-to-end driver

Runs the three phases as **subprocesses** (`sys.executable <script> ...`), chaining artifacts through a work dir. Each `_run(cmd, env)` prints `\n$ <cmd>\n` then executes; a non-zero exit aborts the whole run with `[run] step failed (exit N): <cmd>`.

Flags (argparse):

| flag | type / default | meaning |
|---|---|---|
| `--lang` | str, default `"python"` | source language: `python \| rust \| typescript \| go \| starlark \| shell \| powershell \| auto` (auto = merged mixed-language graph) |
| `--source-root` | Path, **required** | root of the source tree |
| `--files` | str, default `""` | comma-separated files relative to source-root for phase 1; empty = auto-discover |
| `--skeleton` | Path, optional | user-authored skeleton.yaml (**required for phase 2+**; hard error `"[run] phase 2 needs --skeleton"` otherwise) |
| `--work-dir` | Path, **required** | directory for intermediates + outputs |
| `--title` | str, default `"Handbook"` | handbook H1 title |
| `--project-name` | str, default `""` | short display name; falls back to `--title` |
| `--project-brief` | str, default `""` | 1–3 sentence description |
| `--project-brief-file` | Path, default None | read brief from a file (**overrides** `--project-brief`; content `.strip()`ed) |
| `--project-kind` | str, default `""` | noun ("agent harness", "web service"...); default effective value `"codebase"` |
| `--out-lang` | choices `zh`/`en`, default `zh` | handbook output language |
| `--phase` | str, default `"all"` | `all \| 1 \| 2 \| 3 \| 1-2 \| 2-3` (see semantics below) |
| `--max-iters` | int, default 10 | phase 2 max iterations |
| `--max-rounds` | int, default 3 | phase 3 critic rounds per unit |
| `--max-stage-workers` | int, default 4 | phase 3 concurrent stage generation (1 = serial) |
| `--limit` | int, default None | phase 2: cap number of functions (smoke test) |
| `--limit-units` | int, default None | phase 3: cap functions per stage (smoke test) |

**Phase selection semantics** (`_expand_phases`): lower-cased/stripped spec; `"all"` → `{1,2,3}`; `"a-b"` → `set(range(int(a), int(b)+1))`; otherwise `{int(spec)}`.

**Derived paths** (all under resolved `--work-dir`):
- `phase1/` → `graph.json` etc. (`p1_out`)
- `phase2/iterations/` (`p2_iters`), `phase2/iterations/final/` (`p2_final`)
- `phase2/mapping.yaml` (`mapping`)
- `phase3/` (`p3_root`), final output in `phase3/output/`

**Environment plumbing** (`_child_env`): child processes get `PYTHONPATH` prepended with `<pkg-root>`, `<pkg-root>/adapters`, `<pkg-root>/phase2`, `<pkg-root>/phase3` (flat imports). On top of that:
- All phases: `HANDBOOK_PROJECT_NAME` (= `--project-name` or fallback `--title`), `HANDBOOK_PROJECT_BRIEF` (from `--project-brief[-file]`), `HANDBOOK_PROJECT_KIND` (= `--project-kind` or `"codebase"`).
- Phase 3 only, additionally: `HANDBOOK_SOURCE_ROOT`, `HANDBOOK_PHASE2_FINAL` (= `<work>/phase2/iterations/final`), `HANDBOOK_PHASE3_ROOT` (= `<work>/phase3`), `HANDBOOK_TITLE` (= `--title`).

**Preconditions checked by run.py**: phase 2 requires `graph.json` to exist ("run phase 1 first"); phase 3 requires `p2_final` dir to exist ("run phase 2 first").

**Subcommand invocations**:
- Phase 1: `python run_phase1.py --lang L --source-root R --out <work>/phase1 [--files ...]`
- Phase 2: `python phase2/iterate_phase2.py --graph <work>/phase1/graph.json --source-root R --skeleton-yaml <skeleton resolved> --mapping <work>/phase2/mapping.yaml --iterations-dir <work>/phase2/iterations --max-iters N [--limit N]`
- Phase 3: `python phase3/assemble_doc.py --lang {zh|en} --max-rounds N --max-stage-workers N [--limit-units N]` (all paths passed via env). On success prints `[done] handbook in <work>/phase3/output/`.

### 1.2 `run_phase1.py` — Phase 1 standalone CLI

| flag | default | meaning |
|---|---|---|
| `--lang` | `"python"` | one of `base.available_languages()` or `auto` |
| `--source-root` | required Path | must be an existing directory (else `ap.error`) |
| `--files` | `""` | comma-separated relative paths; each must exist (missing files → error listing them) |
| `--out` | required Path | output dir for the four artifacts |

Behavior:
- `--lang auto`: `base.discover_all(source_root)` → `{lang: [files]}` for every registered adapter that discovers ≥1 file; analyzes each group with its adapter, merges `functions` + `edges` into one `ModuleAnalysis`, calls `build_graph.build(..., lang="multi", default_ext=".py")`. Cross-language calls simply fail to resolve and land in `dropped_calls.json`.
- Single-language: adapter from registry; discovery via `adapter.discover(source_root)` unless `--files` provided; `default_ext = adapter.extensions[0]`. Prints `[scan] lang=... root=...` and `[scan] N files`.

### 1.3 `project_context.py`

```python
@dataclass(frozen=True)
class ProjectContext: name: str; brief: str; kind: str
```
`get_project_context()` reads env: `HANDBOOK_PROJECT_NAME` (default `"this codebase"`), `HANDBOOK_PROJECT_BRIEF` (default `""`), `HANDBOOK_PROJECT_KIND` (default `"codebase"`), all `.strip()`ed.

`ProjectContext.block(lang)` renders a prompt-prefix block:
- en:
  ```
  # Project context
  - Name: <name>
  - Kind: <kind>
  - One-line brief: <brief>          # only when brief non-empty
  Everything below documents THIS project's code. Whenever the text says "the system" / "this codebase", it means the project above.
  ```
- zh: `# 项目背景` with `项目名称/项目类型/一句话简介` lines and analogous closing sentence.

This block is prepended to: Pass A/B/C/D actor prompts, Tier 1/2/3 prompts, register-appendix prompt, translate_member prompt. (Not used by ordering Step 3.5 or the Critic role prompts.)

Additional optional env-based enrichment (in `phase2/apply.py`): `HANDBOOK_SUBSYS_FILE_MAP` (JSON `{ "<file rel path>": "<subsys stage id>" }`) and `HANDBOOK_SUBSYS_BOUNDARY_MAP` (JSON `{ "<boundary-id substring>": "<subsys stage id>" }`) — both default `{}`, malformed JSON logged and ignored. `HANDBOOK_CROSSCUT_NAMES` (JSON `{func_name: crosscut_stage_id}`) is only used by `llm_analyze.py`'s `--dry-run` synthetic outputs.

---

## 2. IR data model (`ir.py`) and Phase 1 artifacts

### 2.1 Dataclasses (identical byte-for-byte to `handbook_generate_large/ir.py` — the sibling "large" pipeline uses the exact same IR file; no differences)

```python
@dataclass
class FunctionNode:
    id: str                 # "<module_id><sep><qualname>", e.g. "terminus_2.Terminus2._run_agent_loop"
    name: str               # leaf name
    qualname: str           # relative to module, e.g. "Terminus2._run_agent_loop"
    file: str               # relative to source_root
    line_start: int
    line_end: int
    signature: str
    is_async: bool
    is_method: bool
    class_name: Optional[str]
    decorators: list[str]
    kind: str = "internal"
    synthetic: bool = False # True for synthesized nodes (e.g. dataclass __init__); line_* are 0
    used_self_attrs_read: list[str] = []
    used_self_attrs_written: list[str] = []
    params_types: dict[str, str] = {}   # param name -> resolved type name

@dataclass
class BoundaryNode:
    id: str                 # "boundary:<qualname>"
    name: str               # leaf segment
    qualname: str           # full dotted path
    module: str             # package/module path without trailing class
    class_name: str         # owning class or ""
    kind: str = "boundary"

@dataclass
class CallEdge:
    caller_id: str
    callee_id: str          # node id, "boundary:<q>", or "unresolved:<hint>"
    is_await: bool
    call_type: str          # self_method | self_attr_method | param_method | internal_func |
                            # internal_constructor | boundary | boundary_constructor | unresolved
    line: int
    raw: str                # call-expression head text, <= 80 chars ("...abc" truncated at 77+"...")

@dataclass
class ModuleAnalysis:
    functions: list[FunctionNode]
    edges: list[CallEdge]   # includes unresolved; partitioning is build_graph's job
```

### 2.2 Phase 1 artifacts written to `<out>/`

Four files, identical schema for every language:

#### `graph.json`
```json
{
  "metadata": {
    "generated_at": "<UTC ISO8601>",
    "language": "python|rust|...|multi",
    "harness_dir": "<absolute source_root>",
    "scanned_files": ["a.py", "sub/b.py"],
    "n_internal_functions": 96,
    "n_boundary_nodes": 41,
    "n_edges": 310,
    "policy": "Edges are emitted only when the callee resolves to a named function (internal or boundary). Unresolved/builtin calls live in dropped_calls.json."
  },
  "nodes": {
    "<node_id>": {
      /* FunctionNode asdict() plus: */
      "n_callees": 3,        // out-degree (count of kept edges where this node is caller)
      "n_callers": 5         // in-degree
      /* or BoundaryNode asdict() plus n_callees/n_callers */
      /* or a synthesized __init__ node, see below */
    }
  },
  "edges": [ { "caller_id": "...", "callee_id": "...", "is_await": false, "call_type": "self_method", "line": 120, "raw": "self._step" } ],
  "self_attrs": {
    "<ClassName>": { "<attr>": { "read_in": ["<fn id>", ...], "written_in": [...] } }
  }
}
```
Node table construction (`build_node_table`):
- All FunctionNodes as dicts, degree counts computed over KEPT edges only.
- Every edge-referenced id not already present:
  - `boundary:<qual>` → BoundaryNode with `(module, class_name, leaf)` from `_split_boundary_qualname(qual)`: split on `.`; the first segment (before last) starting with an uppercase letter is the class; module = everything before it; leaf = everything after. If no uppercase segment: module = all but last, class "", leaf = last.
  - `*.__init__` → synthesized internal node: `{id, name:"__init__", qualname:"<ClassQual>.__init__", file:"<module_id><default_ext>", line_start:0, line_end:0, signature:"def __init__(self, ...)  # synthesized (no explicit __init__ in source)", is_async:false, is_method:true, class_name:<ClassQual>, decorators:[], kind:"internal", synthetic:true, used_self_attrs_read:[], used_self_attrs_written:[], params_types:{}, n_callees, n_callers}`. (`module_id` = id up to first `.`.)
- `self_attrs` index: for every FunctionNode with a class_name, its `used_self_attrs_read/written` mapped to `{class: {attr: {read_in:[ids], written_in:[ids]}}}`.

#### `functions.csv`
Header: `id,name,qualname,file,line_start,line_end,class,is_async,is_method,decorators,signature,n_callers,n_callees,n_self_attrs_read,n_self_attrs_written,unit_id,unit_name,responsibility` — booleans as `"true"/"false"`, decorators `|`-joined, last three columns always empty (legacy placeholders).

#### `graph.dot`
Graphviz digraph, `rankdir=LR`, rounded boxes, one dashed `cluster_<i>` per file (label = filename) with internal nodes filled `#e8f0fe`, plus a `cluster_boundary` of grey boundary nodes. Edge attrs: `color="#1a73e8"` when `is_await`; `style=dashed` for `boundary|boundary_constructor` call types.

#### `dropped_calls.json`
```json
{
  "metadata": {
    "generated_at": "...", "total_dropped": 123,
    "by_category": {"builtin": 60, "local_var_method": 30, ...},
    "category_explanations": {
      "inherited_method": "self.logger.X / self._logger.X — callee is on a base class we don't scan.",
      "self_attr_unknown": "self._attr.X — we know the attr exists but don't know its type.",
      "string_literal_method": "'X'.method() — call on a string literal; no named callee.",
      "builtin": "len/isinstance/exception constructors — language builtins, no module namespace.",
      "local_var_method": "var.X() — var is a local variable with no type annotation.",
      "bare_name": "X() — closures, super(), and other names not tied to any def."
    }
  },
  "edges_by_category": { "<cat>": [ {"caller": id, "callee_raw": "<hint w/o unresolved: prefix>", "is_await": b, "line": n, "raw": s}, ... ] }
}
```
Categorization (`categorize_dropped`, applied to the callee hint): starts with `self.` → `inherited_method` if second segment is `logger`/`_logger` else `self_attr_unknown`; starts with quote → `string_literal_method`; head token in `_BUILTIN_NAMES` (a fixed Python-flavored set: len, isinstance, range, ... plus common exception class names) → `builtin`; contains `.` → `local_var_method`; else `bare_name`.

`build()` also prints stats: functions / kept / dropped / internal / boundary counts, and per-call_type counts; returns the stats dict.

### 2.3 Edge partitioning
`partition_edges`: edges with `call_type == "unresolved"` → dropped; everything else kept. Only kept edges go into graph.json/graph.dot; dropped go to dropped_calls.json.

---

## 3. skeleton.yaml — the user-authored stage lifecycle

### 3.1 Canonical YAML schema (`skeleton_yaml.py`)

```yaml
metadata:
  version: 1
  generated_from: skeleton.md      # only when bootstrapped from md
  # title: <optional; used as H1 when rendering md>
stages:
  - id: stage-1                    # id prefixes matter: stage- | side- | crosscut- | subsys-
    title: Configuration Crystallization
    description: |
      2–3 sentence prose description. First sentence is used as the "short" form in prompts.
    parent: null                   # parent stage id, or null
    children: [stage-1.1, stage-1.2]
  - id: stage-1.1
    parent: stage-1
    children: []
    ...
state_registers:
  - id: reg-pending-output
    semantics: "what this register holds, who writes/reads it ..."
subsystems:
  - id: subsys-tmux
    role: "one-line role"
```

Conventions:
- Stage id charset (from parser regex): `[a-zA-Z][a-zA-Z0-9.\-]*`. Hierarchy is expressed BOTH by `parent`/`children` and by the id suffix convention `X.N` (e.g. `stage-4.1` child of `stage-4`, `side-S1.1` child of `side-S1`).
- `stage-*` = main flow, `side-*` = side flows, `crosscut-*` = cross-cutting utility buckets, `subsys-*` = subsystem internals. Registers `reg-*`, subsystems `subsys-*`.
- Phase 2 treats `crosscut-*` stages specially (no moves out of them; excluded from uses_crosscuts derivation). Phase 3 render order: top-level `stage-*` (children inlined depth-first) → `side-*` → `crosscut-*`/`subsys-*`.

YAML I/O details worth reproducing: custom SafeDumper that (a) never emits anchors/aliases, (b) emits multi-line strings in block `|` style (rstripped + trailing `\n`), (c) emits short scalar lists (≤8 items, each item int/float/bool or str ≤40 chars) in flow style `[a, b]`, sort_keys=False, allow_unicode, width=10000.

Helpers: `stage_ids(doc)`, `stage_by_id(doc, sid)`, `stage_short_descriptions(doc)` → `{sid: "<title>: <first sentence of description (split on '. ')>."}`.

### 3.2 Bootstrap from markdown (`parse_skeleton.py` + `skeleton_yaml.py convert_md_to_yaml`)

`skeleton_yaml.py` CLI: `bootstrap` (md → yaml) and `render` (yaml → md), flags `--md`/`--yaml` (defaults point at a legacy `handbook/phase2/` layout).

`parse_skeleton.parse_skeleton(md_path) -> SkeletonTable{stages: dict[id→StageEntry], registers: dict[id→semantics], subsystems: dict[id→role]}`:
- Scans headings `^#{2,4}\s+(.*)$` containing a backticked ID whose value starts with `stage-`/`side-`/`crosscut-`.
- Heading title = heading text minus the backticked ID, minus a leading `Stage|Sub-stage|Side Flow|Cross-cut` word, minus a leading em-dash.
- Description = the first paragraph after the heading (stops at blank line after content, table row `|...`, or `---`).
- `## State Registers` section: rows `| \`reg-x\` | semantics |` → registers (semantics = last cell).
- `## Subsystems` section: rows `| \`subsys-x\` | role |` → subsystems.
- `StageEntry.short()` = `"{id} — {title}: {first sentence}."`; `SkeletonTable.to_prompt_block()` renders "Available stages (use these IDs exactly): ..." plus "Available subsystem refs:" lines (used only by the legacy step-1 `llm_analyze.py`).

`convert_md_to_yaml` derives parent/children from id suffix (`^(.*?)(\.\d+)$` where the prefix is an existing id) and writes the doc shape above.

`render_md_from_yaml` regenerates a structural markdown (H1 `"{title} — Skeleton"`, "auto-generated, edit YAML" note, `## Main Flow` / `## Side Flows` (side- top-level) / `## Cross-cutting Concerns` (crosscut-), recursive stage headings `"{title}  \`{id}\`"` at level parent+1, then `## State Registers` and `## Subsystems` tables).

### 3.3 Validation at use time
There is no standalone schema validator; validity is enforced operationally: Phase 2 initializes `mapping.stages` from skeleton stage ids, Pass A drops assignments to stage ids not in the skeleton, Pass B/C/D validate ids against the skeleton set, Phase 3 keys everything by stage id.

**Important invariant**: user-authored `skeleton.yaml` (and md) are never overwritten during Phase 2 iteration; evolved skeletons live only in `iterations/iter_N/` and `iterations/final/`.

---

## 4. Phase 1 — static analysis

### 4.1 Adapter contract (`adapters/base.py`)

```python
class LanguageAdapter(abc.ABC):
    name: str = ""; extensions: tuple[str, ...] = ()
    @abstractmethod
    def analyze(self, files: list[Path], source_root: Path) -> ModuleAnalysis
    def statement_spans(self, file_path, qualname) -> list[tuple[int,int]] | None   # default: None (unsupported)
    def discover(self, source_root) -> list[Path]   # default: rglob per extension, skip COMMON_SKIP_DIRS, sorted
```
- `COMMON_SKIP_DIRS` = {.git,.hg,.svn, node_modules,vendor,target,build,dist,out, __pycache__,.mypy_cache,.pytest_cache,.ruff_cache,.tox, venv,.venv,env,.env,site-packages, .idea,.vscode}.
- `statement_spans` returns 1-based inclusive `(start,end)` line spans of statements inside a named function's body — the legal boundaries Phase 2 snaps LLM region ranges to. None → Phase 2 keeps LLM range and flags `needs_review`.

**Registry**: `register(name, factory, extensions)` populates `_REGISTRY` + `_EXT_INDEX`; `get_adapter(lang)` (KeyError w/ registered list), `adapter_for_file(path)` (by suffix), `available_languages()`, `discover_all(root)` (per-language discovery, skipping empty/broken). `_autoregister()` imports all concrete adapter modules at import time, tolerating ImportErrors (e.g. missing tree-sitter).

**Tree-sitter loading**: `get_ts_parser(lang)` — cached; prefers `tree_sitter_language_pack.get_parser`, falls back to standalone `tree_sitter_<lang>` modules (typescript uses `language_typescript()`); RuntimeError with a clear message otherwise.

**`TSNode` wrapper**: normalizes py-tree-sitter binding differences (property vs method access — `kind`/`type`, `start_point`/`start_position` etc.). API: `.kind .start_byte .end_byte .start_row .end_row .is_named .text .child_count .named_child_count`, `child(i) field(name) children() named_children() children_of_kind(*k) first_of_kind(*k) descendants_of_kind(*k)` (pre-order). `collect_line_spans(body)` = deduped sorted set of every named descendant's 1-based (start,end) — a superset of statement boundaries (fine as snap candidates). `parse_tree(lang, source)` handles bytes/str binding disagreement.

### 4.2 Python adapter (`python_adapter.py`) — stdlib `ast`, most precise

Two passes.

**Pass 1 — `_ModuleScanner` per file** (`module_id` = relative path minus `.py`; note: keeps `/` in path — module ids for nested files are like `"pkg/mod"` with the `.py` stripped; the legacy id form joins with `.` only inside the qualname):
- imports: `import a.b as c` → `{c: "a.b"}`; `from m import x as y` → `{y: "m.x"}`.
- classes: `module_classes`, per-class method-name sets `class_methods`.
- functions/methods at any nesting: qualname composition `class.nesting.name` / `class.name` / `nesting.name` / `name`; id = `f"{module_id}.{qualname}"`. `is_method` = has class, not nested, not `@staticmethod`. Signature = `("async " if async) + "def name(<ast.unparse(args)>)( -> ret)?"`. Decorators unparsed to strings. Nested defs recursed via `_visit_for_nested` (recorded as their own FunctionNodes with dotted nesting qualnames).
- `_SelfAttrTracker`: within a function body (not entering nested defs/lambdas), records `self.X` reads (any non-Store attribute access on `self`) and writes (Assign/AugAssign/AnnAssign-with-value targets, tuple/list destructuring; AugAssign also counts as read).
- `params_types` (`_collect_param_types`): for each annotated arg (excluding `self`): extract type name from annotation — `Name` → id; `Attribute` → unparse; `X | None` union → first non-None side; `Optional[T]` → T; other subscripts → None. Skip generic builtins ({str,int,float,bool,complex,bytes,bytearray,list,dict,tuple,set,frozenset,object,type,None,Any}); resolve through the import table.
- Local (function-level) imports collected into `local_imports[fn_id]` (not descending into nested defs/lambdas; `import *` skipped).
- `self_attr_types` learned in `finalize()` from method bodies (all methods, not just `__init__`): `self.x = SomeName(...)` (skip generic builtins; resolve through imports) or `self.x = self.method(...)` where the method's return annotation is a simple non-generic name (strip `| None`; reject if contains `[]|, `).
- method return annotations tracked in `_method_returns[(class, method)]`.

**Pass 2 — `_CallExtractor`** with `class_to_module` (class name → first module defining it) and `function_ast_index[(file, lineno, name)] → ast node`; `internal_module_ids` = set of module ids. `_iter_calls(fn_node)` walks the function body (also arg defaults), skipping nested defs/lambdas, flagging `is_await` when the call sits directly under `ast.Await`; nested calls inside a call are visited with `inside_await=False`.

Resolution `_resolve_call` (with `imports = module imports ∪ caller's local imports`):
- **A. bare `Name()`**:
  - local class → `internal_constructor` to `{mod}.{Name}.__init__`
  - local module function → `internal_func` to `{mod}.{name}`
  - imported name: last segment capitalized →
    - class known in another scanned module → `internal_constructor` `{that_mod}.{Class}.__init__`
    - else `boundary_constructor` `boundary:<qual>`
    - imported name whose first path segment is an internal module id → `internal_func` to `<qual>`
    - else `boundary` `boundary:<qual>`
  - else `unresolved:<name>`
- **B. Attribute call**:
  - B1 `self.m()`: method exists on caller's class → `self_method` `{mod}.{cls}.{m}`; else `unresolved:self.<m>`
  - B2 `self.attr.m()`: attr type known → internal class → `self_attr_method` `{target_mod}.{Type}.{m}`; else `boundary:<type>.<m>`; unknown attr → `unresolved:self.<attr>.<m>`
  - B3 `x.m()` where x is a Name:
    - `x` is a typed param → internal type → `param_method`; else `boundary:<ptype>.<m>`
    - `x` in imports: `x` is a known internal class name → `internal_func` `{target_mod}.{x}.{m}`; else `boundary:<qual>.<m>`
    - else `unresolved:<x>.<m>`
- **C. anything else** → `unresolved:<unparse>`.
`raw` = `ast.unparse(func)` truncated to ≤80 chars (77 + "...").

**`statement_spans`**: parse file; strip leading qualname parts not in top-level names; single part → find the top-level def with that name; else find top-level class named `parts[0]` and its direct method named `parts[-1]`; collect ALL `ast.stmt` spans (`(lineno, end_lineno)`) at any depth under the body, deduped and sorted. (Only handles top-level functions and direct class methods.)

### 4.3 Rust adapter (`rust_adapter.py`) — tree-sitter

- `module_id`: path minus `.rs`, split on `/`, drop segments `mod|lib|main` (and empty), join with `::`; separator for ids/qualnames is `::`.
- Discovery skips `{target,.git,node_modules}`.
- Scans top-level items and recursively `mod` blocks (`prefix` accumulates `mod::`): `use` declarations (handles `a::b::C`, `use ... as`, nested `use_list`s, ignores wildcards) into imports; `struct`/`union` (+ field types via `_core_type_name`, skipping `_GENERIC_TYPES` = Rust primitives + Vec/Box/Option/Result/HashMap/... containers); `enum` (name only); `trait` default methods with bodies (owner = trait); `impl Type` methods; free `function_item`s. `attribute_item`s immediately preceding a fn become its `decorators`.
- Method-ness: parameters contain `self_parameter` (or first param text contains "self"). Async: `function_modifiers` contains "async". Signature: `("async " )fn name(params)( -> ret)?`. self-attrs: reads = `self.field` field_expressions; writes = assignment/compound-assignment LHS `self.field`.
- FunctionNode id `= {module_id}::{qualname}`; `qualname = prefix + owner? + '::' + name`; class_name includes prefix.
- `_core_type_name` peels reference/generic/scoped types; `a::b::C` → `C`.
- Call resolution over `_iter_calls(body)` (skips nested `function_item`/`closure_expression`; `.await` marks await; macro_invocations yielded as calls):
  - macro `foo!()` → `boundary` to `boundary:<macro>!`
  - bare identifier: local free fn → `internal_func`; imported and name is a known internal type → `internal_constructor` `{tmod}::{Name}::new`; imported → `boundary:<qual>`; else `unresolved:<name>`
  - `A::b()` scoped: owner segment is a known internal type → `internal_constructor` if leaf ∈ {new, default, from} else `internal_func`, to `{tmod}::{Owner}::{leaf}`; else `boundary_constructor` if owner capitalized and leaf ∈ {new,default,from} else `boundary`, to `boundary:<full path>`
  - field expressions: `self.m()` → `self_method` if m ∈ methods of the bare owner type (last `::` segment of class_name); `self.field.m()` via struct field types → `self_attr_method`/`boundary`/`unresolved`; `param.m()` via `params_types` → `param_method`/`boundary`; else unresolved.
- `statement_spans`: find any `function_item` whose name == qualname's `::`-leaf; `collect_line_spans(body)`.

### 4.4 TypeScript adapter (`typescript_adapter.py`) — tree-sitter, extensions `.ts .tsx`

- Discovery skips `{node_modules,.git,dist,build}` and `*.d.ts`. `module_id` = path minus extension, `/`→`.`.
- Scans (unwrapping `export_statement`): `import_statement` (named specifiers → `local → "<source>::<name>"`; namespace import → `local → "<source>"`); `function_declaration`; `class_declaration` (methods via `method_definition`; constructor parameter-properties and typed class fields seed `field_types[(cls, field)]`, skipping `_GENERIC_TYPES` = {number,string,boolean,any,unknown,void,never,object,Array,Promise,Map,Set,Record,Date,Object}); class fields holding arrow/function expressions are recorded as methods (their bodies analyzed); `const x = () => {}` top-level arrows recorded as free functions.
- FunctionNode: id `{module_id}.{qualname}` with `.` separator, qualname `Owner.name` or `name`; signature = declaration text up to body start (≤200 chars); is_async = any child token `async`; decorators from `decorator` children; self-attrs = `this.X` member_expressions (reads) / assignment LHS (writes).
- Call resolution (`_iter_calls` skips nested function scopes; `await_expression` marks await):
  - identifier: local free fn → `internal_func`; imported → `boundary:<import>`; else unresolved
  - `this.m()` → `self_method` if in class's method set, else `unresolved:this.<m>`
  - `this.field.m()` via field_types → `self_attr_method`/`boundary`/unresolved
  - `x.m()`: typed param → `param_method`/`boundary`; `x` imported → `boundary:<import>.<m>`; else unresolved
- `statement_spans`: matches `function_declaration|method_definition` by leaf name; also arrow/function-expression values of `public_field_definition|field_definition|variable_declarator`.

### 4.5 Go adapter (`go_adapter.py`) — tree-sitter, `.go`

- Discovery skips `{.git,vendor}` and `*_test.go`. `module_id` = path minus `.go`, `/`→`.`.
- Scans `import_declaration` (`local pkg name → import path`), `type_declaration` (type names; struct fields → `field_types`, skipping Go builtins `_GENERIC_TYPES`), `function_declaration` (free), `method_declaration` (owner = receiver's core type; `recv_var` plays the role of self).
- `_core_type` peels `*T`, `[]T`, `map`… , `pkg.T` → T.
- FunctionNode: `is_async` always False; decorators `[]`; self-attrs via `selector_expression` on the receiver var (reads) and assignment_statement LHS (writes); signature = text up to body (≤200).
- Call resolution (never await):
  - identifier: free fn → internal_func; else unresolved
  - `r.M()` (receiver) → `self_method` or unresolved
  - `r.field.M()` via struct field types → `self_attr_method`/`boundary`/unresolved
  - `x.M()`: typed param → `param_method`/`boundary`; `x` is imported pkg → `boundary:<import path>.<M>`; else unresolved
- `statement_spans` matches `function_declaration|method_declaration` by dotted-leaf name.

### 4.6 Scripting adapters (`scripting_adapters.py`) — Starlark / Shell / PowerShell

Shared `_ScriptAdapter` free-function model: one FunctionNode per function definition (`class_name=None, is_method=False, is_async=False`, no attrs/param types; signature = text up to body, ≤200). Call edges from each body: callee name defined anywhere in scanned set → `internal_func` to `{owning_module}{sep}{name}`; else `boundary:<name>`. Never `unresolved`.
- Starlark: extensions `.star .bzl .bazel`, grammar `starlark`, fn kind `function_definition`, calls = `call` nodes, name = last dotted segment of the callee expr.
- Shell: `.sh .bash`, grammar `bash`, calls = `command` nodes' first `command_name` token, basename of a path (`/usr/bin/git` → `git`).
- PowerShell: `.ps1 .psm1 .psd1`, grammar `powershell`, fn kind `function_statement` (name via field or `function_name` child; body via field or `script_block`), same command extraction.
- `statement_spans`: match fn by leaf name; `collect_line_spans(body)`.

### 4.7 Extraction granularity
FunctionNodes are emitted for: free functions, class/impl methods (incl. trait default methods with bodies, TS arrow-valued class fields, Go receiver methods), nested Python functions. Classes are NOT nodes themselves — they surface only through methods, constructor edges (`X.__init__`, `Type::new`), and the self_attrs index. Modules/files exist only as grouping metadata (`file` field, dot clusters).

---

## 5. Phase 2 — LLM classification (Critic-Actor iteration)

### 5.1 `iterate_phase2.py` CLI

| flag | default |
|---|---|
| `--skeleton-yaml` | legacy `handbook/phase2/skeleton.yaml` |
| `--skeleton-md` | legacy path (accepted but effectively unused inside `run()`) |
| `--graph` | legacy `handbook/phase1/graph.json` |
| `--source-root` | env `HANDBOOK_SOURCE_ROOT` or `.` |
| `--mapping` | `phase2/mapping.yaml` |
| `--iterations-dir` | `phase2/iterations` |
| `--max-iters` | 10 |
| `--limit` | None (cap functions, smoke test) |
| `--no-pass-b` / `--no-pass-c` / `--no-pass-d` / `--no-ordering` | debug toggles |

Cache dirs default under `mapping.yaml`'s parent: `cache/stage_orders`, `cache/pass_b`, `cache/pass_d`.

### 5.2 mapping.yaml document shape

```yaml
metadata:
  phase2_iteration_run: true
stages:
  stage-1:
    members:
      - qualname: Terminus2._run_agent_loop
        type: function            # "function" | "region"
        file: terminus_2.py
        line_range: [994, 1176]   # 1-based inclusive; null possible
        sha1: <sha1 of the joined source lines>
        purpose: "60–150 word 5-aspect description"
        # region-type members additionally carry:
        # original_llm_range: [a, b]
        # snap_status: ok|snapped|needs_review|no_range
        # snap_distance: int
        # snap_note: "..."         (optional)
        # first_line / last_line   (optional echo from the LLM)
        # narrative_section: "branch: fallback"  (optional, from Step 3.5)
    uses_crosscuts: [crosscut-X1]      # derived
    subsystem_refs: [subsys-tmux]      # derived (via HANDBOOK_SUBSYS_* env maps)
    structure: linear                  # from Step 3.5: linear|branched|unordered|empty
    narrative_rationale: "..."
unmapped_functions:
  - qualname: Foo.name
    file: foo.py
    reason: api_surface        # api_surface | dead | synthetic_dataclass | missing_llm_output
    purpose: "..."             # optional (kept for api_surface entries so the handbook can still describe them)
```

`initial_mapping_doc`: metadata + one empty stage entry (`{members:[],uses_crosscuts:[],subsystem_refs:[]}`) per skeleton stage + `unmapped_functions: []`.

Mapping YAML dumped with the same anchor-free/flow-short-list dumper as skeleton (`_dump_yaml`).

### 5.3 The iteration loop (`run()`)

Setup: load skeleton + graph; mapping starts EMPTY; seed the work queue `invalidated` = sorted qualnames of every internal, non-synthetic node with `line_start is not None` (capped by `--limit`); keep `in_graph_qualnames` for phantom filtering; `_wipe_previous_snapshots` removes only `iter_*`/`final` dirs from a previous run.

Each iteration `iter_i in range(max_iters)`:

1. **Pass C (skeleton doctor)** — runs FIRST, but **skipped on iter 0** (empty mapping ⇒ nothing to analyze). Its invalidated qualnames join the queue consumed by THIS iteration's Pass A. Crash → logged, treated as zero changes.
2. **`_clean_invalidated`** queue hygiene: (a) order-preserving dedup; (b) drop phantoms not in `in_graph_qualnames` (logged); (c) re-inject qualnames whose `unmapped_functions.reason == "missing_llm_output"` (and in graph, not already queued) so prior failures retry. Invariant: `invalidated empty ⟺ no work remains`.
3. **Pass A** classify every queued qualname (parallel, see §5.4). Carry-over rule for next iter: qualnames NOT in returned summaries, plus qualnames whose summary contains `actor_failed` (transient LLM failure), are carried over; accepted or Critic-DISCARDED ones are not retried.
4. **Post-A dedup** `apply.dedup_members` (drop same-stage function-entries that coexist with region entries for the same qualname).
5. **Pass B** (global reassignment audit) — moves invalidate the moved qualnames (queued for next iter's Pass A).
6. **Pass D** (region boundary revision) — runs LAST among LLM passes; does NOT invalidate.
7. **Mechanical post-pass** (guarded try/except so a crash doesn't lose LLM progress): `dedup_members`, `rederive_uses_crosscuts_and_subsystem_refs`, `populate_unmapped`.
8. **Step 3.5 ordering** `order_stage_members.order_all_stages` (fingerprint-cached; convergence-neutral since state_hash sorts member keys).
9. **Snapshot** to `iterations/iter_<i>/`: `skeleton.yaml`, `mapping.yaml`, `changes.md` (a per-pass changelog), `invalidated.txt` (one qualname per line). Also rewrite the top-level `mapping.yaml` after every iter. The SOURCE skeleton.yaml is never overwritten.
10. **Convergence**: `state_hash(skeleton, mapping)` (sha1 over sorted stage ids + per-stage sorted member `(qualname,type,line_range)` tuples). Converged iff `prev_hash == current_hash AND invalidated == []` → `_finalize` and return 0. Otherwise continue; hitting max_iters → `_finalize` with note "Forced stop..." and return 1.

`_finalize`: re-run Step 3.5 ordering, write `iterations/final/` snapshot (same four files; changes.md = the note), rewrite top-level mapping.yaml.

### 5.4 Pass A — per-function classification (`pass_a_classify.py`)

For each invalidated qualname (looked up in graph nodes by qualname; internal, non-synthetic, has line info):
1. Render the function source with line numbers (`render_source_with_line_numbers`: `"{lineno:5d}: {line}"`, inclusive, end clamped to file length).
2. Build **caller/callee context** from graph edges + current mapping: for each unique caller/callee qualname: `{qualname, stages: sorted set of stages it appears in, purpose: first function-type purpose (≤120 chars)}`. Boundary callees appear as `{qualname:"boundary:...", stages:[], purpose:"(boundary)"}`.
3. Build **mapping overview**: per non-empty stage, up to 4 members (functions first then regions) as `[F]/[R] qualname — first-sentence-of-purpose(≤90)`, plus `... (N more)`.
4. **Actor prompt** = project context block (en) + `ACTOR_RULES` + "## Available stages (use these IDs exactly)" (from `stage_short_descriptions`) + "## Function metadata" (qualname/file/line_range/line_count/is_async/is_method/class_name/decorators/n_callers/n_callees/reads attrs/writes attrs/signature) + "## Callers ..." + "## Callees ..." + "## Current mapping overview ..." + "## Function source (line-numbered)" in a ```python fence + "Return only the JSON block."
5. **actor_critic_loop** with critic_role `"engineer"`, `max_revise_rounds=1`, `review_evidence` = the same ground truth (function header, signature, attrs, caller/callee lists with purposes, stage menu, line-numbered source).
6. If accepted: LLM-echoed `qualname` is force-overridden to the requested one (hallucination guard), `file`/`line_range` backfilled from the node, then `apply.apply_classification(mapping_doc, prop, source_root, valid_stage_ids)`.

**Pass A proposal schema** (`_PROPOSAL_SCHEMA_HINT`):
```json
{
  "qualname": "str",
  "purpose": "str (60-150 words, 5 aspects: ACTION / INPUTS+STATE READ / OUTPUTS+STATE WRITTEN / WHEN INVOKED / NON-OBVIOUS)",
  "granularity": "function" | "region",
  "function_assignments": ["stage-X", ...],
  "regions": [{"line_range":[a,b], "first_line":"...", "last_line":"...", "purpose":"30-80 words", "stage_id":"..."}] | null,
  "file": "str",
  "line_range": [start, end]
}
```
Key ACTOR_RULES semantics: function = single cohesive unit (≤30 lines / single purpose); region = 2–10 contiguous regions ending at statement boundaries, each with its own stage; stage ids only from the menu; genuine cross-cutting utilities go ONLY to a `crosscut-*` stage (calling a logger doesn't make you crosscut); trivial public API accessors → `function_assignments=[]` (recorded as unmapped api_surface); subsystem-internal helpers go to the driving main-flow stage unless a dedicated `subsys-*` stage exists; be consistent with caller/callee stage context.

**Concurrency**: ThreadPoolExecutor `max_workers=6`. Workers build prompts against ONE `copy.deepcopy(mapping_doc)` snapshot taken at submit time (avoids dict-changed-during-iteration races); the main thread applies accepted classifications serially as futures complete. Worker exceptions → summary `WORKER_CRASH`. Missing summary slots backfilled defensively.

**apply_classification** (in `apply.py`) mechanics:
- Dedup duplicate `function_assignments` (keep first, warn).
- **Silent-wipe guard**: if no function_assignments AND no regions AND NOT (granularity=="function" AND purpose non-empty) → refuse to modify anything (leave prior state for retry), warn.
- Otherwise: remove all existing entries for the qualname from every stage.
- With assignments/regions: purge the qualname from `unmapped_functions`. Without assignments but function+purpose: upsert an `unmapped_functions` entry `{qualname, file, reason:"api_surface", purpose}` (or add purpose to an existing entry).
- Consistency fixes: granularity=function with regions → drop regions (warn). granularity=region with no regions → treat as function (warn).
- Function-level entries: for each valid stage id (invalid ones dropped with warning) append `{qualname,type:"function",file,line_range,sha1,purpose}` — sha1 = `_sha1_of_range` (join lines [start-1:end] with `\n`, sha1 of utf-8).
- Region entries (granularity=region): compute `statements = find_function_statements(file, qualname)` once (via adapter dispatch); for each region: skip missing/invalid stage_id (warn); reject inverted line ranges (warn); **AST snap** (see §5.9): snapped range + `snap_status/snap_distance/snap_note`, cross-check `first_line/last_line` (mismatch escalates status), or `needs_review`+"could not locate function in AST" when statements unavailable; sha1 over the final range; store member with `original_llm_range` and optional `first_line/last_line`.
- Returns `[]` (Pass A never invalidates others).

### 5.5 Pass B — global reassignment audit (`pass_b_reassign.py`)

Scope: per stage, only **pure function members** (type==function whose qualname has NO region entries anywhere). Crosscut stages skipped entirely as a source (`crosscut_skip`); stages with <2 pure members skipped (`trivial`).

Cache: `cache/pass_b/<stage_id>.json` with fingerprint = sha1 of `json.dumps([stage_id, sorted (qualname,purpose) pairs])`. Fingerprint match → skip LLM (`cache`); saved payload `{stage_id,fingerprint,proposed,applied,rejected}`. Non-dict/corrupt cache → miss. LLM failure → no cache write (retry next iter).

Actor prompt: project block + `ACTOR_RULES` (better-fit definition; what doesn't count — "approximately fits" stays, no style moves, moves OUT of crosscut forbidden; destination must exist and differ; crosscut→anywhere forbidden, main→crosscut allowed; cap 3) + audited stage header (id/title/first-sentence desc/size) + full member list (`- qualname  file=..  line_range=..\n  purpose: <=400 chars`) + stage menu (`sid (n=size) title — first-sentence ≤90`) + cap reminder.

Proposal schema:
```json
{ "proposals": [ {"qualname": str, "from_stage": str, "to_stage": str, "reason": str} ],  // ≤3
  "rationale": str }
```

Reviewers: `actor_multi_critic_loop` with roles `["architect","engineer"]` (both must approve; 1 revise round), review_evidence = same members + menu. Legit "no misplacements" may be `{}`/missing key — only `final_proposal is None` or not accepted counts as `llm_failed`.

Mechanical validation per proposal (`_validate_proposal`): qualname/from/to present and strings; from == audited stage; to != from; qualname is a current pure-function member; to in skeleton; source not crosscut; qualname has a function-type entry in from; no region entries appeared meanwhile. Valid → `apply.apply_reassignment(mapping, qn, [from], [to])` (moves ALL member entries for the qualname between stages, dedup by (type, line_range); preserves properties). Result cached; applied moves are returned and their qualnames become `invalidated` for next iter.

Return shape: `{applied:[{qualname,from_stage,to_stage,reason}], proposed, rejected, invalidated: sorted unique moved qualnames, per_stage: {sid: "crosscut_skip"|"trivial"|"cache"|"llm_failed"|"llm"|"crashed"}, summary}`.

Also has a standalone CLI (`--mapping --skeleton --cache-dir --force`).

### 5.6 Pass C — skeleton doctor (`pass_c_skeleton_doctor.py`)

One Actor call per iteration over the whole skeleton+mapping distribution; **3 critics (engineer, architect, reader), ALL must approve** (with 1 aggregate revise round).

Actor prompt: project block + `ACTOR_RULES` + "## Current skeleton" (per stage: id, parent (or `(top)`), children count, first-sentence desc ≤80) + "## Current mapping distribution" (per stage from `compute_mapping_stats`: members count, functions/regions split, dominant file and share) .

ACTOR_RULES highlights: propose at most 3 changes; look for STAGE OVERLOAD (>20 members, esp. one dominant file → split_stage), STAGE STARVATION (1-member sub-stages → merge), MISSING SUBSYSTEM STAGE (scattered helpers → add_stage), DEAD STAGES (→ remove_stage). CAUTION—PARTIAL MAPPING: don't remove merely-empty stages mid-iteration; `remove_stage` of a populated stage MUST supply `move_to`. `split_stage` MUST move ≥1 qualname into a non-source stage.

Change schemas:
```json
{"action":"add_stage","new_stage":{"id":"...","title":"...","description":"...","parent":"...|null","children":[]},
 "move_members":[{"qualname":"...","from_stage":"..."}]}
{"action":"remove_stage","stage_id":"...","move_to":"...|null"}
{"action":"merge_stages","stages_to_merge":["sid1","sid2"],"into":"target-sid"}
{"action":"split_stage","source_stage":"...","new_stages":[{"id":"...","title":"...","description":"...","parent":"...","members":["qn1",...]}]}
```
Top-level: `{"changes":[...0..3...],"rationale":"..."}`; healthy skeleton → `{"changes": [], "rationale": "Skeleton is balanced; no changes proposed."}`.

Mechanical validation (`_validate_change`): add_stage — id required and unique, every move_members.from_stage known, every qualname a non-empty string actually member of from_stage. remove_stage — id in skeleton; move_to (if given) known and != stage_id; populated stage requires move_to. merge_stages — non-empty source list, all known, `into` required. split_stage — source known; ≥1 new_stage; every listed member qualname must currently live in the source stage; at least one non-source new stage must carry members. Unknown action → reject.

Apply (in `apply.py`):
- `apply_skeleton_add_stage`: idempotent add to skeleton (children filtered to existing ids with warning; parent back-pointer updated, or parent nulled with a warning if missing); `_ensure_stage` in mapping; each move via `apply_reassignment`; returns moved qualnames (invalidated).
- `apply_skeleton_remove_stage`: members moved to `move_to` (or just removed if null — "transiently homeless", NOT added to unmapped) and all invalidated; stage deleted from mapping + skeleton + parents' children lists.
- `apply_skeleton_merge_stages`: synthesize the target in skeleton if missing (cloned title/parent from first source, description "Merged stage formed from [...]"; abort with warning if no template); each source's members reassigned to target and invalidated; source removed from mapping+skeleton+children lists.
- `apply_skeleton_split_stage`: ensure each new stage exists in skeleton+mapping; move claimed members (first claim wins, duplicates warned); if source not among new ids and left empty → remove source from mapping+skeleton+children back-refs; leftovers keep the source alive (warn).

Return: `{changes_applied, changes_proposed, changes_rejected, invalidated, summary}`.

### 5.7 Pass D — region revision (`pass_d_region_revision.py`)

Targets: qualnames with ≥2 region entries anywhere (`find_multi_region_qualnames`). Regions gathered across stages, sorted by line_range start; each shown with a 0-based index.

Skips (per function, `source` labels): `trivial` (<2 regions), `no_node` (graph node missing/no file/invalid line info), `no_source` (file unreadable), `cache` (fingerprint hit), `llm_failed`, `apply_failed`, else `llm`; crash → `crashed`.

Cache: `cache/pass_d/<qualname sanitized>.json`, fingerprint = sha1 of `[qualname, source_sha1(fn range), sorted (stage_id, line_range tuple, purpose)]`. Only successful runs cached; `apply_failed` intentionally not cached.

Actor prompt: project block + `ACTOR_RULES` + function header (qualname/file/line_range/region_count) + current regions (`[i] line_range=.. stage=..\n purpose ≤250`) + skeleton stage menu + callers/callees (same context builder as Pass A, deduped) + line-numbered source + cap reminder. Critic: single **engineer**, 1 revise round, same evidence.

Actions (≤3 total; `drop` explicitly forbidden — every line must keep a stage owner):
```json
{"action":"merge","region_indices":[i,j,...],"purpose":"30–80 words"}          // adjacent only
{"action":"split","region_index":i,"at_line":N,"left_purpose":"...","right_purpose":"...","left_stage":"sid","right_stage":"sid"}  // at_line = last line of left half, strictly inside
{"action":"reassign_stage","region_index":i,"new_stage":"sid"}
```
Top-level `{"actions":[...],"rationale":"..."}`.

Per-action validation (`_validate_action`): merge — ≥2 distinct int in-range indices, consecutive when sorted, non-empty purpose. split — in-range int index; at_line int strictly inside the region's range; left/right stage keys (if present) must be non-empty strings in the skeleton; left/right purpose (if present) non-empty strings. reassign_stage — in-range index; new_stage a non-empty string in skeleton and different from the region's current stage. Plus **batch conflict detection** (`_detect_batch_conflicts`): an action referencing indices already "killed" by an earlier action in the same batch (merge kills all but its lowest index; split kills its own index) is rejected.

Apply (`apply.apply_region_revision`): builds a working list with stable `_orig_idx` identities; merges combine ranges (min start, max end) into the lowest index and mark others dead; splits mark the original dead and append two halves with synthetic negative identities (unreachable by later LLM indices); reassign mutates stage_id; then all region entries for the qualname are wiped from the mapping and re-added from the surviving work items sorted by start line, sha1 recomputed. (Snap metadata is NOT preserved on rebuilt regions.) Returns `[qualname]` (but Pass D discards this — no invalidation).

Return: `{applied:[{qualname, actions}], proposed, rejected, per_qn, summary}`. Standalone CLI available.

### 5.8 Step 3.5 — stage member ordering (`order_stage_members.py`)

Per stage: n==0 → `{"structure":"empty", source:"trivial"}`; n==1 → linear/trivial (strip stale `narrative_section`). Else:

Cache `cache/stage_orders/<sid>.json`, fingerprint over sorted member identities `(qualname, type, line_range tuple)` — identity only, not purpose/order. Cached payload stores `structure`, `order_identities` (identity dicts in flat order), `section_identities` (`[{label, identities}]`), `rationale`, `source`. Decode maps identities back to current 1-based indices; any failure → re-run LLM. Only `source=="llm"` results are cached (fallbacks retry next time).

Actor prompt (NO project block): `ACTOR_RULES` (structure types linear/branched/unordered, default linear; output schema below; invariants: exact permutation coverage, no overlaps) + stage header + numbered member list (1-based; qualname/type/line_range + purpose ≤200) + same-stage caller→callee index pairs from the graph (`(a) → (b)` lines, or "(none observed)").

```json
{ "structure": "linear"|"branched"|"unordered", "rationale": "...",
  "order": [1-based indices]                       // linear
  "spine": [...], "branches":[{"label":"...","members":[...]}]   // branched (spine non-empty AND branches non-empty)
  "groups": [{"label":"...","members":[...]}]      // unordered
}
```
Critic: **editor** role, 1 revise round. Validation `_validate_ordering` enforces exact 1..N permutation across the structure's fields (branched requires non-empty spine AND branches). Invalid/failed → **mechanical fallback**: linear order by `(file, line_start, type_rank{function:0,region:1}, line_end)`, `source="fallback"`, rationale "Fallback to line-start order (LLM unavailable or invalid)."

Applied: `stage.members` reordered; when sections exist (>1 section or a labeled single section), each member gets `narrative_section` = `"spine"` / `"branch: <label>"` / `"group: <label>"` (stale labels always stripped first). Stage also gets `structure` and `narrative_rationale` keys. Standalone CLI available.

### 5.9 AST snap (`ast_snap.py`)

`snap_range(requested_start, requested_end, statements, snap_threshold=3)`:
- snapped_start = min `s.lineno >= requested_start` (fallback: last statement's start); snapped_end = max `s.end_lineno <= requested_end` (fallback: first statement's end).
- inverted result → `needs_review`, keep original.
- distance = max(|Δstart|,|Δend|); status: 0 → `ok`; ≤threshold → `snapped`; >threshold → `needs_review`.

`find_function_statements(file, qualname)` dispatches via `adapter_for_file(...).statement_spans(...)`; any exception → None.

`verify_first_last_lines(file, (start,end), first_line, last_line)`: tolerant match — 30-char prefix of expected in actual, or vice versa, on stripped text; returns (ok, note) with `first_line mismatch...`/`last_line mismatch...` fragments.

Standalone mode (legacy step-2 flow): `run(cache_dir, source_root, report, threshold)` mutates the `phase2/cache/llm_outputs/*.json` records from `llm_analyze.py` in place (idempotent: re-snap always from `original_llm_range`), setting `line_range/original_llm_range/snap_status/snap_distance/snap_note`, escalation when both first/last mismatch, and writes `ast_snap_report.json` `{total_regions, snapped, needs_review, rows:[{qualname, region_stage_id, original_range, snapped_range, distance, status, note}]}`. In the current pipeline the same snapping happens inline inside `apply_classification`.

### 5.10 `llm_analyze.py` (legacy Step 1; not called by the iteration driver, but the shared helpers live here)

Shared helpers used everywhere: `render_source_with_line_numbers(file,start,end)` and `function_sha1(file,start,end)`.

Standalone: per-function single-shot LLM classification (prompt = `PROMPT_SYSTEM_RULES` + `skeleton_table.to_prompt_block()` from skeleton.md + metadata + line-numbered source) writing per-function cache files `phase2/cache/llm_outputs/<qualname sanitized>.json`:
```json
{ "qualname","file","line_range":[a,b],"sha1","llm_output":{...same Pass A schema...},
  "raw_text_preview":"<=2000 chars","error":null,"elapsed_sec":1.2,"prompt_chars":9000 }
```
plus `_index.json` `{count, qualnames:[...], errors:[{qualname,error}]}`. Skips cached entries whose sha1 matches and llm_output ok unless `--force`. Flags: `--graph --skeleton --cache-dir --source-root --workers(6) --limit --force --only --dry-run` (dry-run synthesizes fake outputs, using `HANDBOOK_CROSSCUT_NAMES`). ThreadPool max_workers=6.

### 5.11 Critic framework (`critic.py`)

Roles → hand-written reviewer persona prompts: **engineer** (code-level correctness of classification/boundaries/crosscut misuse/caller-callee consistency), **architect** (structural: clean stage boundaries, bloat >20 / starvation <2, subsys invasion, genuine multi-identity), **reader** (handbook readability: do members fit, intuitive titles, regions as narrative steps, reader surprise), **editor** (ordering: structure matches content; linear order sanity; branch distinctness; unordered independence). Unknown role falls back to engineer.

Critic output contract (`_CRITIC_OUTPUT_RULES`): decisions APPROVE (be GENEROUS, "correct-enough is APPROVE"), REVISE (only specific actionable material flaws; concerns must be non-empty), REJECT (fundamental, concerns non-empty, suggested_revision null). JSON:
```json
{"decision":"APPROVE|REVISE|REJECT","concerns":["..."],"suggested_revision":{...}|null,"rationale":"one sentence"}
```
Critic prompt = role block + "## Task context" + optional "## Review evidence (ground truth for judgement)" + "## Proposal under review" (JSON fenced) + optional "## Proposal schema reminder" + output rules.

`parse_verdict` hardening: non-dict → error; decision must normalize (strip/upper) to canonical set; non-list concerns coerced to []; `suggested_revision` must be dict or null (else parse error). Parse failures logged with reason + ≤300-char raw preview.

`_normalize_vacuous_revise`: REVISE with empty concerns → APPROVE (warn) — avoids a wasted revise round.

**`actor_critic_loop`** (1 critic): actor → parse fail ⇒ `actor_failed` (rounds=0, accepted False). critic verdict None ⇒ discard (rounds=1, verdicts empty ⇒ summary says `actor_failed` — note: `summarize_result` reports `actor_failed` whenever `critic_verdicts` is empty, which also covers critic-call failure). APPROVE ⇒ accept p1. REJECT ⇒ discard. REVISE ⇒ build revise prompt (original prompt + previous proposal JSON + bulleted concerns + optional suggested revision + "address every concern"), actor v2, critic round-2 (context notes its round-1 verdict); after 2 rounds anything but REJECT accepts p2.

**`actor_multi_critic_loop`** (Pass C/B): all critics review v1 sequentially; broken critic ⇒ synthetic REJECT verdict. All APPROVE ⇒ accept. Else aggregate all concerns (`[role] concern` lines) into one REVISE, actor revises once, each critic re-reviews (with its own round-1 verdict in context); accepted iff NO round-2 REJECT.

`summarize_result(result,label)`: `"{label}: ACCEPTED after N round(s)( (k critics))"` / `"{label}: actor_failed"` / `"{label}: DISCARDED (DEC1, DEC2, ...)"`.

### 5.12 Derived fields & unmapped

`rederive_uses_crosscuts_and_subsystem_refs(mapping, graph)`: crosscut stages get empty lists. For every other stage: `uses_crosscuts` = sorted set of crosscut stages housing any callee (by qualname) of any member; `subsystem_refs` = sorted set from (a) boundary callee ids containing any `HANDBOOK_SUBSYS_BOUNDARY_MAP` substring, (b) internal callees whose file is in `HANDBOOK_SUBSYS_FILE_MAP` and differs from the caller's file.

`populate_unmapped(mapping, graph)`: rebuilds `unmapped_functions` from scratch (preserving prior purposes keyed by qualname): every internal node — synthetic ⇒ `synthetic_dataclass` (always listed); else if assigned in any stage skip; else `api_surface` if public name and (line_end-line_start) ≤5; else `dead` if n_callers==0; else `missing_llm_output`. Sorted by (qualname, file).

`dedup_members`: same-stage rule only — drop function entries whose qualname also has region entries in that stage; returns count.

`state_hash`: sha1 of `repr((sorted stage ids in skeleton, [(stage_id, sorted (qualname,type,line_range-tuple) member keys)] sorted by stage))`.

---

## 6. Phase 3 — LLM narration (actor-critic-reflexion, tiered)

### 6.1 `assemble_doc.py` CLI + env

Flags: `--lang {zh,en}` (default zh), `--stage <id>` (only that stage; skips Tier 1 + register appendix), `--limit-units N`, `--max-rounds` (default 3), `--max-stage-workers` (default 4), `-v/--verbose`.

Paths from `config.py` env (`HANDBOOK_SOURCE_ROOT`, `HANDBOOK_PHASE2_FINAL`, `HANDBOOK_PHASE3_ROOT`, optional `HANDBOOK_CACHE_ROOT` default `PHASE3_ROOT/cache`, `HANDBOOK_OUTPUT_ROOT` default `PHASE3_ROOT/output`, `HANDBOOK_TITLE` default "Handbook"). Defaults fall back to `<pkg>/work/...` so bare imports still work. `UI_STRINGS[zh|en]` fixed labels: overview "🗺️ System Overview"/"🗺️ 系统总览", registers "🔄 State Flow Reference"/"🔄 状态流动总览", fns "Function details"/"函数细节".

Inputs: `PHASE2_FINAL/mapping.yaml` + `PHASE2_FINAL/skeleton.yaml`.

Output basename: `handbook[_<stage>][_<lang if != zh>]` → `OUTPUT_ROOT/<base>.json` + `<base>.md` (markdown rendered from the tree). HTML is produced by `render_doc.py --json ...` (writes `.md` + `.html`) or the legacy `render_html.py --input md --output html`.

### 6.2 Build algorithm

1. `stage_render_order(skeleton)` (top-level stage-* DFS through children, then side-*, then crosscut-*/subsys-*) and `stage_chapter_numbers` (gap-free positional numbering "1", "1.1", ... for stage-* only; side/crosscut/subsys fall back to raw id).
2. **Tier 1** (skipped with `--stage`): `produce(api, RUBRICS["tier1"], ground_truth="", gen=make_tier1_gen(...), max_rounds)` → `doc.overview_md`, `overview_score`, `overview_findings`.
3. **Per stage** (concurrent across stages, `max_stage_workers`; sequential when ≤1 or single stage):
   - StageNode with id/chapter/title/parent/children/members_count.
   - **Tier 2**: `produce(RUBRICS["tier2"], "", make_tier2_gen(stage, members, skeleton, adjacent_brief, lang))` → `logical_md`, score, findings. `adjacent_brief` = `"prev: <sid> <title> | next: <sid> <title>"` from the render order.
   - **Tier 3**: `collect_units(sid, members, SOURCE_ROOT)` (groups members by qualname preserving first appearance; extracts + sha1-verifies every snippet — a `Sha1Mismatch` raises and kills the stage worker); units processed **sequentially** so each prompt sees `sibling_synopses` (list of `(qualname, synopsis)` of already-done siblings; last 8 used in the prompt). Each unit: `produce(RUBRICS["tier3"], ground_truth_tier3(unit, skeleton), make_tier3_gen(...))`; `parse_tier3_output` (json.loads, fallback fenced-block extraction) → FunctionNode{qualname, type_kind, translation, score, findings}. `--limit-units` caps units per stage.
   - Stage worker exceptions are logged and the stage is simply omitted from the doc.
4. Stages assigned to the doc in skeleton render order regardless of completion order.
5. **Register appendix** (skipped with `--stage`): `gen_register_appendix(api, skeleton, refresh=False, lang)` — single plain LLM call, content-hash cached at `CACHE_ROOT/narrative/register-appendix_<lang>_<sha1[:12]>.md` (key over prompt version + lang + project name/brief + registers brief + all-stage brief). Failure → warning, empty.

### 6.3 The tier loop (`tier_loop.produce`)

```
for rnd in 1..max_rounds (default 3):
    output  = gen(lessons_block + revise_block)          # actor
    verdict = score_tier(api, rubric, output, ground_truth)   # critic → deterministic compute_verdict
    track best (strictly higher overall wins)
    if verdict.passed: break
    lesson = reflect(api, verdict)   # one-sentence highest-leverage fix; appended to lessons
    if rnd>=2 and (history[-1]-history[-2]) < 0.05: break     # plateau
    revise_block = revise_findings_block(verdict)
return LoopResult(best_output, best_verdict, rounds=len(history), history, lessons)
```
- `lessons_block`: `"\n\n## Lessons from this review so far (address them)\n- ..."`.
- `revise_findings_block`: `"## Reviewer findings — fix every one in your next attempt"` + `BLOCKING (must fix): gates` + actionable findings + per-criterion findings (`- [name] finding`).
- Reflection prompt (`_REFLECT_PROMPT`): given tier, failed gates, ≤8 findings → output ONLY one instruction sentence. Failure → "".

### 6.4 Rubrics (`rubrics.py`)

`Criterion(name, kind: gate|soft, weight, check, floor=3)`; `Rubric(tier, purpose, critic_mindset, criteria, threshold=4.0)`. `compute_verdict`: per-criterion score int-coerced and clamped 1..5, missing/malformed → 1; overall = weighted average (rounded 3dp); gate_failures = gates scoring < floor; `passed = overall >= threshold and no gate failures`.

- **tier1** (novice overview; simplification is a virtue): gates purpose_clarity(.25), what_it_does(.20), novice_accessibility(.20); soft shape_fidelity(.20), scannability_style(.15).
- **tier2** (stage role + control flow + data flow): gates stage_role(.18), control_flow(.22), data_flow_validity(.25 — State Flow block present, registers real & right direction); soft explains_why(.15), adjacency(.10), right_altitude_style(.10).
- **tier3** (precise per-function): gates accuracy(.25), io_params_precision(.25), register_accuracy(.15); soft code_detail_fidelity(.15), non_obvious_surfaced(.12), section_purity_style(.08).

Critic prompt (`tier_critic.build_critic_prompt`): "You are a strict, experienced reviewer scoring ONE generated handbook unit for this tier." + `rubric.to_prompt_block()` (purpose, mindset, criteria list with GATE floors, "GATE criteria are non-negotiable...") + scoring calibration (1–5 independent, strict, quote evidence, one concrete fix per non-full-mark criterion) + either "Verify every factual claim against the ground truth below..." + GT block (Tier 3 only) or "There is no external ground truth... do NOT invent factual errors" (Tier 1/2) + the output + `verdict_schema_hint()`:
```json
{ "scores": { "<criterion>": {"score": 1-5, "evidence": "why", "findings": ["fixable point"]} },
  "actionable_findings": ["most important fixes as instructions"] }
```
Broken critic (call error / no JSON) → all-1 verdict with a retry finding (loop retries rather than passing junk).

### 6.5 Tier actors (`tier_actors.py`)

- `make_tier1_gen`: base = `_PROMPTS_BY_LANG[lang]["tier1"].format(project_name, project_block, stages_brief, side_brief, registers_brief)`; gen(extra) = `_clean_narrative(api.call(base+extra).raw_text)`.
- `make_tier2_gen`: format with stage id/title/description, `_members_brief` (≤30 members as `- qualname (type, lines [a,b])` + "... (N more)"), `_stage_registers_brief` (registers whose semantics mention the stage id; else a "(not mentioned...)" placeholder line), adjacent_brief (or "(none)"/"(无)").
- `_clean_narrative` post-processor: strips word-count annotations like `（70-150 字）`/`(120–180 words)` and demotes any markdown heading by 2 levels (max 6) so tier output nests under stage headings.
- `make_tier3_gen`: base = `translate_member.build_prompt(unit, skeleton, sibling_synopses, lang)`; gen(extra): up to 2 internal attempts; each parses JSON and runs `validate_translation`; valid → pretty-printed JSON string; else return last raw text (critic will score it low).
- `ground_truth_tier3`: function header + per-entry line_range/sha1[:8] + ```python snippet``` + full state_registers list (id + semantics ≤160).
- `parse_tier3_output`: `json.loads` else `_extract_json_block`.

### 6.6 Tier 3 translation (`translate_member.py`)

`TranslationUnit{stage_id, qualname, entries (mapping member dicts), snippets (verified Snippets, parallel), type_kind single|multi_region}`. `TIER3_PROMPT_VERSION = "v3-generic"`.

Prompt structure (bilingual header/fragment dictionaries): project context block → intro ("You are a senior engineer on {project} and the translator...") → `# Input` → `## Translation unit` (qualname/stage/type+entry count) → `## Owning stage` (id/title/description) → `## Already-translated siblings ... (most recent 8)` (or "none" marker) → `## state_registers (...)` — ALL registers, id + semantics ≤250 (or "none" marker) → `## Per-entry detail` (per entry: `### Entry i · type=.. · line_range=.. · sha1=<8>`, `**phase2 purpose**:` text, `**source**:` python fence) → translation principles (8 rules: intent over mechanism, anchored to code, surface non-obvious decisions, accurate; granularity, cross-reference siblings, honest complexity, register/style guidance; section mutual-exclusion priority ⑥>④>③) → the single or multi_region output schema → self-check list (6 items) + "Emit only the ```json block."

**single schema** (validated):
```json
{ "schema_version": 1, "type": "single",
  "locator_role": "one-line role tag",
  "stage_context": "2-4 sentences",
  "synopsis": "2-4 sentences",
  "interface": { "signature": "(self, environment) -> None",
                 "params": [{"name","type","role"}], "reads_state": ["self._x"],
                 "returns": "...", "side_effects": ["..."] },
  "execution_flow": ["step 1 ...", "..."],          // 2-8 steps
  "design_decisions": ["...", "..."],               // 1-5
  "relations": { "callers": [...], "core_callees": [...],
                 "config_state_sources": [...], "results_to": [...],
                 "siblings": [],
                 "register_interactions": [{"action":"write|read|clear|reset","register":"reg-x","note":"..."}] } }
```
**multi_region schema**: same top plus `overall_structure`: `[{region_idx, line_range, role, terminal_state}]` and `regions`: `[{region_idx, line_range, title, gloss (2-5 sentences), callouts:[{to_qualname, note}]}]`; `execution_flow` replaced by region glosses; design_decisions/relations stay function-level.

`validate_translation` (mechanical): dict; schema_version==1; type matches unit kind; locator_role/stage_context/synopsis non-empty strings; interface dict with non-empty signature; relations.{callers,core_callees,config_state_sources,results_to} all non-empty lists; register_interactions if present a list of dicts with action ∈ {write,read,clear,reset} and non-empty register string; design_decisions non-empty list; single → non-empty execution_flow; multi → regions count == entries count, each region has gloss + line_range, overall_structure count == regions count.

Standalone `translate_unit` (not used by assemble_doc, which routes through the tier loop): cache at `CACHE_ROOT/translate/<stage>/<safe_qualname>[.lang].json`, cache_key = sha1(prompt version [+ `|lang=..|` for non-zh] + all snippet sha1s)[:16]; record stores `{stage_id,qualname,type_kind,n_entries,lang,cache_key,translation,raw_llm_text}`; up to `max_retries=2` attempts with validation; RuntimeError with last error + 500-char raw preview on exhaustion.

### 6.7 Source extraction (`extract_source.py`)

`Snippet{qualname,file,line_range,text,sha1}`. `extract(source_root, qualname, file, line_range, expected_sha1)`: validates range (start≥1, end≥start, end ≤ file length); text = `"\n".join(lines[start-1:end])` using `splitlines()`; sha1 mismatch vs the mapping's recorded sha1 raises `Sha1Mismatch` with the "rerun phase2" guidance — the physical basis of NL↔code reversibility.

### 6.8 Document tree (`document.py`) — `handbook*.json` schema

```json
{
  "meta": {"lang": "en", "max_rounds": 3},
  "overview": {"content_md": "...", "score": {"overall":4.2,"passed":true,"gate_failures":[],"scores":{"purpose_clarity":5,...}}, "findings": ["..."]},
  "stages": {
    "stage-1": {
      "id":"stage-1","chapter":"1","title":"...","parent":null,"children":["stage-1.1"],
      "logical_md":"<tier-2 markdown>","score":{...},"findings":[...],
      "functions":[{"qualname":"...","type_kind":"single|multi_region","translation":{...tier-3 JSON...},"score":{...},"findings":[...]}],
      "members_count": 7
    }
  },
  "order": ["stage-1","stage-1.1","stage-2","side-S1","crosscut-X1"],
  "registers_md": "<register appendix markdown>",
  "coherence_findings": []
}
```
`HandbookDoc.read/write` round-trips this; `top_level()` = ordered parentless stages.

### 6.9 Rendering

**Markdown (`render_doc.render_md`)**: `# {title}` → `## {overview label}` + overview_md + `---` → for each stage in order: `##|###`(child) `"{chapter} · {title}"` + logical_md + one `render_unit` card per function (needs the unit reconstructed from mapping via `collect_units` — source re-verified; missing unit or empty translation skipped; render exception → `<!-- render failed for qn: e -->` comment) → `## {registers label}` + registers_md.

**Function cards (`render_member.render_unit`)** — `<details id="fn-<slug>">` blocks (slug = non-alnum→`_`, lowercase, `fn-` prefix):
- single: `<summary><b>qualname</b> — file:start-end · locator_role</summary>`, blockquote stage_context, sections (bilingual labels): synopsis ("What this code does"/"这段代码在干什么"), interface (signature in backticks; params `\`name\`: \`type\` — role`; reads/returns/effects lines), execution flow (numbered), Source (```python snippet```), Non-obvious design decisions (bullets), Relations (labelled lines Callers/Core callees/Config-state sources/Results to/Related siblings, each item a string or dict stringified `\`head\` — note`; register interactions as `✏️ writes \`reg-x\` — note; 👁 reads ...` with per-lang icon labels).
- multi_region: summary shows `file:first_start-last_end (N regions) · role`; `###` sections synopsis / interface / overall structure (table `| Region | Lines | Role | Terminal state |`) then `---`-separated `#### Region i · title (file:a-b)` blocks (gloss, optional callout blockquotes `⤵ This region calls [\`qn\`](#fn-slug) — note`, region code fence via a line_range→snippet lookup, `_(source snippet unavailable)_` when no match), then cross-region design decisions + relations.

**HTML**: two paths.
- `render_doc.render_html(doc)`: single-page nested-collapse — toolbar (expand/collapse all, theme toggle), sidebar TOC built from the tree, `<h2 id="overview">`, each top-level stage a `<details class="stage" id="stage-<chapter>">` containing Tier 2 HTML, recursively nested child stages, and `📚 Function details` cards; registers section; reuses `render_html._BASE_CSS`/`_JS` + pygments CSS. Markdown converted with python-markdown `extra + codehilite + sane_lists + smarty`, `<details>` tags get `markdown="1"` injected so inner markdown renders.
- `render_html.py` (md → html): same CSS/JS; TOC scraped from rendered H2/H3 (details blocks stripped first); heading ids injected by slugifying text (CJK-aware, dedup with `-2` suffixes). CSS: light/dark via `[data-theme="dark"]` variables; localStorage-persisted toggle; sticky sidebar; details cards styled; mobile single-column. JS: TOC scroll-spy, theme toggle, expand/collapse all.

---

## 7. `phase2/api_client.py` — the LLM client

OpenAI-compatible `/chat/completions` wrapper (used by ALL LLM calls in Phase 2 and 3).

**Env resolution (module import time)**:
- model: `OPENAI_MODEL` → `HANDBOOK_LLM_MODEL` → `"gpt-4o-mini"`
- base URL: `OPENAI_BASE_URL` → `HANDBOOK_LLM_BASE_URL` → `"https://api.openai.com/v1"` (rstripped `/`; `/chat/completions` appended)
- api key: `OPENAI_API_KEY` → `HANDBOOK_LLM_API_KEY` → `""` — **missing key raises EnvironmentError at construction** ("set OPENAI_API_KEY ... For a keyless local endpoint, set OPENAI_API_KEY=EMPTY")
- max tokens: `OPENAI_MAX_TOKENS` → `HANDBOOK_LLM_MAX_TOKENS` → 16000
- retries: `HANDBOOK_LLM_MAX_RETRIES` (default 3); backoff: `HANDBOOK_LLM_RETRY_BACKOFF` (default 2.0 s)

Note: README documents the `HANDBOOK_LLM_*` names as overrides that "win", but the code actually prefers `OPENAI_*` first.

**`Api.call(prompt, params=None) -> LLMCallResult`**: single-turn user message. Reasoning-model detection `_is_reasoning_model` (regex `gpt-5|gpt-4\.1|o[1-9]`, case-insensitive): reasoning ⇒ `max_completion_tokens` and no `temperature`; classic ⇒ `max_tokens` (+ optional `params["temperature"]`). `requests.post` with `timeout=request_timeout` (default 3600 s). Retry loop up to max_retries with linear backoff `backoff*attempt + U(0,0.5)` jitter; **permanent client errors (400,401,403,404,405,410,422) raise immediately** (no retry); 408/429/5xx and transport exceptions retry. Exhaustion ⇒ `RuntimeError("LLM call failed after N attempts: ...")`.

**Response parsing**: `_extract_assistant_text` tries, in order: `choices[0].message.content`, `data.choices[0].message.content`, `data.response`, `response`, `result.content`, `data.content`, `text`; else returns the JSON body (or the raw non-JSON body). `_extract_json_block(text)`: prefer ```json fenced blocks (any that parses); fallback: first balanced `{...}` scan with string/escape awareness, advancing past unparseable candidates. `LLMCallResult{raw_text, status_code, request_id (uuid4), elapsed_sec, parsed_json (dict|None), error ("no JSON block found" when None)}`.

**Concurrency**: the Api object is shared across threads; each call is an independent HTTP request. There is no client-side rate limiting beyond retries. Thread pools: Pass A workers=6 (hardcoded default arg), llm_analyze workers=6 (`--workers`), Phase 3 stage workers = `--max-stage-workers` (default 4); everything else (Pass B/C/D, ordering, tier loop rounds, Tier-3 units within a stage) is sequential.

---

## 8. Output formats — final handbook

- `work/<repo>/phase3/output/handbook[_stage][_lang].json` — the HandbookDoc tree (§6.8), including per-unit critic scores/gate failures/findings, making the actor-critic loop auditable.
- `.../handbook[_...].md` — linear GitHub-readable markdown (§6.9): H1 title; "🗺️ System Overview" section (Tier 1: overview paragraph, two ASCII ```text diagrams (lifecycle ~5 lines; main flow 12–15 lines with 6–8 steps and 1–2 yes/no decisions), top-level stage bullet list); per-stage chapters `## 1 · Title` / `### 1.1 · Title` with Tier 2 prose whose fixed shape is (a) opening "why this stage exists" 70–150 words, (b) main flow prose/numbered list with `function_name()` glosses, (c) `**📊 State Flow**` block (`- writes/reads/clears: \`reg-id\` — ...`, `- triggers downstream: <stage>`, or the "(no explicit register interactions)" line), (d) 1–2 sentence pipeline hand-off — followed by collapsible per-function `<details>` cards with source code embedded; final "🔄 State Flow Reference" appendix of per-register `### 🔄 \`reg-id\`` cards (Purpose / Lifecycle: Default Value/Reset/Write/Read/Clear-Refill / Cross-Iteration behavior / Why This Design).
- `.html` (on demand): self-contained single page, sidebar TOC, collapsible stages/cards, light-dark toggle, pygments highlighting.

---

## 9. Concurrency, caching/resume, error handling — consolidated

**Concurrency**
- Phase 2 Pass A: ThreadPool(6); prompt context from a single deepcopy snapshot; serial apply on the main thread.
- Phase 3: ThreadPool(`--max-stage-workers`, default 4) across stages; Tier-3 units sequential within a stage (sibling cross-referencing); Tier 1 and register appendix on the main thread.
- Everything else sequential. `Api` shared; no locks needed since appliers are single-threaded.

**Caching / resume**
- Phase 1: none (fast, deterministic).
- Phase 2: fresh run always (mapping starts empty; previous `iter_*`/`final` snapshots wiped). Within-run caches that persist across runs: Pass B per-stage fingerprint cache (`cache/pass_b/`), Pass D per-function fingerprint cache (`cache/pass_d/`), Step 3.5 ordering identity cache (`cache/stage_orders/`). Legacy llm_analyze per-function sha1 cache (`cache/llm_outputs/`) only in standalone use. All caches: fingerprint mismatch or malformed JSON ⇒ miss; only LLM-successful results cached (fallback/failure re-tries).
- Phase 3: the tier loop itself is uncached per run; register appendix content-hash cached in `CACHE_ROOT/narrative/`; standalone `translate_unit` path has a sha1-keyed per-unit cache under `CACHE_ROOT/translate/` (invalidated by `TIER3_PROMPT_VERSION` bumps, per-language keyspace). sha1 verification of every snippet against mapping is the resume-safety mechanism: source drift ⇒ `Sha1Mismatch` telling you to rerun Phase 2.

**Error handling & degradation ladder**
- API: retry w/ jitter on transient; instant raise on permanent 4xx; missing key fails at startup.
- Pass loops: every pass wrapped in try/except at the iteration driver; a crashed pass reports zero changes and the loop continues. Mechanical post-pass crash preserved via try/except (snapshot still saved).
- Pass A worker crash → WORKER_CRASH summary, qualname carried over/retried through the `missing_llm_output` re-injection channel; LLM qualname/file/line hallucinations overridden from graph truth; empty proposals blocked by the silent-wipe guard.
- All LLM proposals pass mechanical validation before apply (invalid stage ids, out-of-range indices, phantom qualnames, inverted ranges, batch conflicts ⇒ rejected + logged, never crash).
- Critic failures: single-critic loop discards conservatively; multi-critic treats a broken critic as REJECT; Phase 3 critic failure yields an all-1 verdict so the loop retries; vacuous REVISE normalized to APPROVE.
- Ordering: invalid LLM permutation ⇒ deterministic line-order fallback (not cached).
- Phase 3: malformed Tier-3 JSON after 2 internal retries is passed to the critic to be scored low; a failing stage worker only loses that stage; markdown render failures become HTML comments; register appendix failure logs a warning.
- Convergence honesty: dedup + phantom-drop + failure re-injection keep `invalidated empty ⟺ no work`; state-hash detects even mechanical-step non-idempotence.

---

## 10. Prompt catalogue (every LLM prompt template)

| # | where | role | intent | key structure |
|---|---|---|---|---|
| 1 | `pass_a_classify.ACTOR_RULES` + `build_actor_prompt` | Actor | classify one function into stages, function- or region-granularity, with 5-aspect purpose | project block; granularity/region/stage-assignment/purpose/consistency rules; stage menu; metadata; caller/callee context w/ stages; mapping overview; line-numbered source; JSON-only |
| 2 | `pass_a` review evidence + `critic.ROLE_PROMPTS["engineer"]` | Critic (engineer) | verify Pass A proposal against real code | role persona; task ctx; evidence = same source+context; proposal JSON; schema hint; APPROVE/REVISE/REJECT rules |
| 3 | `pass_b_reassign.ACTOR_RULES` + `build_actor_prompt` | Actor | audit one stage for misplaced pure-function members, ≤3 moves | better-fit / not-a-move rules; crosscut one-way rule; member list w/ purposes ≤400; stage menu w/ sizes |
| 4 | Pass B critics | Critic ×2 (architect, engineer) | both must approve moves | same evidence |
| 5 | `pass_c_skeleton_doctor.ACTOR_RULES` + `build_actor_prompt` | Actor | propose ≤3 skeleton changes (add/remove/merge/split) from distribution stats | overload/starvation/missing-subsys/dead heuristics; partial-mapping caution; 4 action schemas; skeleton summary + per-stage member/file-dominance stats |
| 6 | Pass C critics | Critic ×3 (engineer, architect, reader) | ALL must approve skeleton changes | evidence = skeleton + distribution stats |
| 7 | `pass_d_region_revision.ACTOR_RULES` + `build_actor_prompt` | Actor | refine one function's region split: merge/split/reassign_stage, ≤3, no drop | 0-based index semantics; at_line = last line of left half; current regions; stage menu; caller/callee ctx; line-numbered source |
| 8 | Pass D critic | Critic (engineer) | verify region actions vs source lines | same evidence |
| 9 | `order_stage_members.ACTOR_RULES` | Actor | choose narrative structure (linear/branched/unordered) + exact permutation | numbered members; same-stage call edges; permutation invariants |
| 10 | ordering critic | Critic (editor) | order matches narrative | member list + inner calls |
| 11 | `critic.build_revise_prompt` | Actor (revision) | address every critic concern | original prompt + previous proposal + concerns + optional suggested revision |
| 12 | `critic._CRITIC_OUTPUT_RULES` (shared) | — | verdict JSON contract, lean-APPROVE calibration | decision/concerns/suggested_revision/rationale |
| 13 | `llm_analyze.PROMPT_SYSTEM_RULES` (legacy step 1) | Actor | one-shot per-function classification (no critic) | same schema as Pass A, skeleton.md stage table |
| 14 | `prompts._TIER1_PROMPT_{ZH,EN}` | Actor | 3-minute whiteboard overview for a novice | writing principles (short sentences, define jargon, shape-not-details); output: overview paragraph (~120–180 words / 150-200字, first sentence = "X is ..."), 2 ASCII ```text diagrams (lifecycle ≈5 lines; main flow 12–15 lines, 6–8 steps, 1–2 decisions, happy path), top-level stage bullets; self-check list |
| 15 | `prompts._TIER2_PROMPT_{ZH,EN}` | Actor | per-stage "why does this stage exist" chapter | why-before-how principles; inputs stage/members/registers/adjacent; output (a) opening 70–150 words (b) main flow (c) fixed `**📊 State Flow**` block (writes/reads/clears/triggers-downstream, register ids only from input) (d) hand-off; self-check |
| 16 | `prompts._REGISTER_APPENDIX_PROMPT_{ZH,EN}` | Actor | one card per state register ("state handoff line") | fixed card template `### 🔄 \`reg-id\`` with Purpose / Lifecycle (Default/Reset/Write/Read/Clear) / Cross-iteration behavior / Why This Design; hard constraints (card count == register count, ids from input, 80–180 words, no H1/H2/hr) |
| 17 | `translate_member` Tier-3 prompt (zh/en) | Actor | translate one function/regions into the 7-section structured JSON | §6.6 — principles, single/multi schema, sibling synopses, all registers, per-entry purpose+source, self-check, JSON-only |
| 18 | `tier_critic.build_critic_prompt` + `rubrics.*.to_prompt_block()` | Critic | score a tier output 1–5 per criterion against rubric (+ ground truth for Tier 3) | strict calibration; per-criterion evidence + findings; verdict JSON `{scores, actionable_findings}` |
| 19 | `tier_critic._REFLECT_PROMPT` | Reflector | distill failing verdict into ONE highest-leverage instruction sentence | tier, failed gates, ≤8 findings → single line |

---

## 11. Miscellaneous implementation notes for a faithful port

- Phase-2 code fences in Actor prompts always say ```` ```python ```` even for non-Python languages (cosmetic; harmless).
- `iterate_phase2` and all standalone CLIs use logging format `"[%(asctime)s][%(levelname)5s] %(message)s"`, level INFO.
- Iteration log line: `"══════════ Iteration i/N  (carry-in: k) ══════════"`, end line with `changes=<count> · carry=<len(invalidated)>` and a per-pass `A: .. · B: .. · C: .. · D: ..` summary; duration formatted `12.3s` / `4m05s` / `1h02m`.
- `changes.md` per iter: `# Iteration i` then `## Pass C — <summary>` with `- applied: <action> → <json ≤200>` lines, `## Pass A — accepted a/n` with `- <summary>` for non-accepted, dedup notes, `## Pass B — ...` with `- moved: qn from → to (reason ≤80)`, `## Pass D — ...` with `- qn: [kinds]`, crash notes.
- `critic.py` contains a dead-code artifact: a `discarded` property is unreachable (defined after a `return` inside `_normalize_vacuous_revise`); do not port.
- `pass_a.classify_one` exists as a single-threaded variant of the worker path (same logic); `run_pass_a` is what the driver uses.
- File-encoding: reads use UTF-8 (`errors="replace"` in tree-sitter adapters; strict elsewhere); all JSON written `ensure_ascii=False, indent=2`.
- The `handbook_generate_large` sibling shares `ir.py` verbatim; its pipeline (build_site.py, run_phase3.py, shared/) is otherwise a different architecture and out of scope here.
- Known quirks to preserve or consciously fix: Python module_id keeps `/` for nested paths (ids like `pkg/mod.Class.fn`); boundary qualname splitting is `.`-based (Rust `::` boundary metadata split is approximate — README documents this); `render_doc.render_html` hardcodes `"zh"` when rendering function cards inside HTML regardless of `lang`; `run_phase1 --lang auto` passes `default_ext=".py"` for synthesized `__init__` file names in mixed repos.

# Functional Specification — `handbook_generate_large` (file-as-leaf handbook pipeline)

Source: `/Users/jack/Desktop/share/Harness_Handbook/handbook_generate_large/`
Purpose of this document: complete behavioral spec sufficient to re-implement the pipeline in TypeScript.

---

## 0. Big picture

Turns a **large** codebase into a navigable **handbook** (markdown + optional HTML), bottom-up,
with the **source FILE as the leaf node**. Coverage is complete by construction: every scanned
file gets a card, every file gets a stage, no file is silently dropped.

```
Phase 1   run_phase1.py            source → phase1/graph.json (+csv/dot/dropped)   [no LLM]
Phase 2a  phase2/read_files.py     read EVERY file → phase2/cards/  (1 card/file)  [O(files) LLM]
Phase 2b  phase2/synth_stages.py   cards → phase2/skeleton.yaml + file_stage.json  [1..N LLM + assign]
Phase 2c  phase2/organize_stages.py order+group each stage → stage_organization.yaml [O(stages) LLM]
Phase 3   phase3/build_handbook.py bottom-up narration → handbook/ (md + html)     [O(stages) LLM]
build_site.py                      post-hoc bilingual static site from 2 handbooks [no LLM]
```

Key design decisions:
- **Stage order comes from the call graph** (entry points, callers-before-callees), so the
  skeleton is a narrative spine, not blind clustering.
- **No function-level classification** — the per-function path lives in the sibling
  `handbook_generate_small`; here the file is atomic.
- All LLM access is a single OpenAI-compatible `Api` client (`shared/api_client.py`), except the
  optional `agent` draft mode which uses a NexAU agent on a separate `LLM_*` endpoint.
- Everything is crash-safe/resumable: cards are written incrementally, rollup summaries are
  content-hash cached, `--resume` skips completed cards.

### Work-dir layout (all artifacts)

```
<work-dir>/
  phase1/
    graph.json            call-graph (nodes+edges+self_attrs+metadata)
    functions.csv         one row per internal function
    graph.dot             Graphviz digraph
    dropped_calls.json    unresolved edges, categorized
  phase2/
    cards/                one JSON per source file, tree-mirrored: cards/<rel-path>.json
    cards/_coverage.json  {n_files, n_described, missing:[...]}
    skeleton.yaml         canonical stage skeleton (SkeletonDoc)
    file_stage.json       {file_stage, buckets, coverage}
    stage_organization.yaml {metadata, stages{...}, coverage}
  handbook/               (default <work-dir>/handbook, overridable)
    overview.md  index.md  register.md  stages… (<stage-id>.md at top level)
    cache/rollup/<sid>_<sha12>.md      cached stage/system summaries
    cache/registers/registers_<sha12>.json
    html/                 (with --phase3-html) overview.html register.html index.html <sid>.html
    handbook.html         (with --html-single on run_phase3) one self-contained page
    agent/                (with --agent on run_phase3) how_to_use.md index.md disambiguation.md <sid>.md
site/                     (build_site.py output; env-overridable)
```

---

## 1. CLI surface

### 1.1 `run.py` — end-to-end driver

Runs `logging.basicConfig(format="[%(asctime)s][%(levelname)5s] %(message)s", level=INFO)`.
Each phase is wrapped in a banner context manager logging
`══════════ <name> ══════════` and `… done in <secs|XmYYs>`.

Flags (argparse):

| Flag | Type/Default | Meaning |
|---|---|---|
| `--lang` | str, `"auto"` | **Phase-1 source-language hint**. `auto` = detect & merge every registered language under source root. Otherwise one of the registered adapters (`python`, `rust`, `typescript`, `go`, `starlark`, `shell`, `powershell`). |
| `--narrate-lang` | `en`\|`zh`, default `en` | Language of ALL handbook-bound prose across 2a/2b/2c/3 (cards, stage titles/descriptions, group titles, rollups, register semantics). |
| `--source-root` | Path, **required** | Root of the source tree. |
| `--files` | str, `""` | Comma-separated files relative to source-root for phase 1; empty = auto-discover. |
| `--work-dir` | Path, **required** | Artifact directory. |
| `--phase` | str, `"all"` | `all` \| `1` \| `2a` \| `2b` \| `2c` \| `2` (= 2a+2b+2c) \| `3` \| comma list e.g. `"2c,3"`. |
| `--read-batch-size` | int, 8 | Files per LLM call in 2a (batch small files; reader auto-degrades batch→per-file→function-chunks on overflow). |
| `--max-chars-per-file` | int, 0 | Source cap per file in 2a; 0 = no truncation (whole file — right for deep mode). |
| `--read-workers` | int, 12 | Concurrent LLM calls in 2a. |
| `--chunk-chars` | int, 60000 | Deep 2a: if a whole-file call fails, split into function chunks of ~this many chars. |
| `--resume` | flag | 2a: skip files that already have a good card in cards/. |
| `--read-detail` | `brief`\|`deep`, default `brief` | 2a depth. brief = 1-line purpose (batched). deep = full-file read → detailed description + per-function purpose/data_flow/relations (pair with batch-size 1). |
| `--assign-workers` | int, 12 | Concurrent LLM calls in 2b file→stage assignment. |
| `--assign-batch-size` | int, 25 | Files per LLM call in 2b assignment. |
| `--synth-mode` | `oneshot`\|`agent`\|`doctor`, default `oneshot` | 2b skeleton synthesis mode (see §5.3). |
| `--max-rounds` | int, 6 | 2b agent/doctor mode: max draft→assign→doctor→reassign rounds. |
| `--doctor-workers` | int, 1 | 2b: parallel actor-critic diagnoses per round. 1 = one global actor (critics still parallel); >1 = one split-only actor-critic per overloaded stage + one global add/merge/remove pass, all concurrent (disjoint scopes). |
| `--doctor-llm-workers` | int, None | Global cap on concurrent doctor LLM calls across both nested pools (diagnosis × critics). Default `max(assign_workers, doctor_workers, 3)`. |
| `--organize-workers` | int, 8 | 2c: stages organized in parallel. |
| `--phase3-workers` | int, 8 | 3: concurrent rollup LLM calls within one tree depth. |
| `--handbook-out` | Path, None | 3: output dir (default `<work-dir>/handbook`). |
| `--phase3-refresh` | flag | 3: ignore cached rollup summaries and regenerate. |
| `--phase3-html` | flag | 3: also render the multi-page HTML site under `<handbook>/html/`. |

Phase-selection semantics (`_expand(spec)`):
- lowercase/strip; `"all"` → `{"1","2a","2b","2c","3"}`; `"2"` → `{"2a","2b","2c"}`;
  comma list → set of tokens; else `{spec}`.

Orchestration details:
- Phase 1 is executed as a **subprocess** (`sys.executable run_phase1.py --lang … --source-root … --out <work>/phase1 [--files …]`)
  with `PYTHONPATH` prepended: repo root, `adapters/`, `shared/`, `phase1/`. Non-zero exit aborts with
  `[run] step failed (exit N): <cmd>`.
- Phases 2a–2c and 3 run in-process. `sys.path` gets `phase2/`, `phase3/`, `shared/` inserted at import.
- Prerequisite checks (exit with message when missing):
  - 2x phases require `<work>/phase1/graph.json` ("run phase 1 first"). Graph is loaded into memory
    and one `Api()` is constructed **only** when a 2x phase runs (a bare `--phase 3` needs no graph and no key
    for phase-2 style calls — Phase 3 constructs its own Api inside build()).
  - 2b requires `cards/`; 2c requires `file_stage.json` + `cards/`; 3 requires
    `cards/`, `skeleton.yaml`, `file_stage.json`, `stage_organization.yaml`.
- After 2b: `skeleton_yaml.save_yaml(skeleton_doc, skeleton.yaml)`; `file_stage.json` written as
  pretty JSON (`ensure_ascii=False, indent=2`). Logs `%d/%d files assigned; %d non-empty buckets`.
- After 2c: writes `stage_organization.yaml` via `yaml.safe_dump(sort_keys=False, allow_unicode=True, width=10000)`.
- After 3: logs stage-page count and entry point (`html/overview.html` when `--phase3-html`, else `overview.md`).
- run.py's Phase-3 call passes `html=args.phase3_html` only — the agent arm and single-page HTML are
  reachable only through `run_phase3.py`.

### 1.2 `run_phase1.py` — standalone Phase 1

Flags: `--lang` (default `python`; help lists `base.available_languages()`), `--source-root` (required),
`--files` (comma-separated relative paths; empty = adapter auto-discover), `--out` (required dir).

Behavior:
- `--lang auto`: `base.discover_all(source_root)` → `{lang: [files]}`; runs each adapter's `analyze`,
  concatenates functions+edges into one `ModuleAnalysis`, calls
  `build_graph.build(..., lang="multi", default_ext=".py")`. Prints `[scan] auto root=…`, `[scan] <lang>: N files`.
- Single-language: resolve adapter; explicit `--files` are validated to exist (error lists missing);
  else `adapter.discover(source_root)` (error if none). `default_ext = adapter.extensions[0]`.
  Prints `[scan] lang=… root=…`, `[scan] N files`, then builds.

### 1.3 `run_phase3.py` — standalone Phase 3

Thin wrapper: sets `sys.path` (phase3, phase2, shared) and delegates to `build_handbook.main()`.
Flags of `build_handbook.main()`:

| Flag | Default | Meaning |
|---|---|---|
| `--phase2-dir` | required | Dir with cards/ + skeleton.yaml + file_stage.json + stage_organization.yaml. |
| `--out` | required | Handbook output dir. |
| `--lang` | `en` (`en`\|`zh`) | Narration language. |
| `--workers` | 8 | Concurrent rollup LLM calls within one tree depth. |
| `--refresh` | flag | Ignore cached rollup summaries. |
| `--subtree` | None | Build only this stage id's subtree (dry-run/inspect; skips registers; index roots = subtree). |
| `--html` | flag | Multi-page HTML site under `<out>/html/` (no LLM). |
| `--html-single` | flag | One self-contained `<out>/handbook.html`. |
| `--agent` | flag | Also render the agent locator index under `<out>/agent/` (no LLM). |
| `--model` | None | Override model for rollup/registers (else `Api()` default). |
| `--api-user` | None | Deprecated, ignored. |
| `--api-key` | None | Override API key (else `$OPENAI_API_KEY`). |

### 1.4 Standalone module CLIs (each module is also runnable)

- `phase2/read_files.py main`: `--graph --source-root --cards-dir --batch-size(8) --max-chars-per-file(0) --detail(brief|deep) --chunk-chars(60000) --resume --lang(en|zh)`.
- `phase2/synth_stages.py main`: `--graph --cards-dir --skeleton-out --file-stage-out` (oneshot defaults).
- `phase2/file_assign.py main`: `--graph --skeleton --out --batch-size(25)`.
- `phase2/synth_agent.py main`: `--graph --cards-dir --draft-only --max-rounds(6) --assign-workers(6) --assign-batch-size(25) --doctor-workers(1) --doctor-llm-workers --no-agent-draft --skeleton-out --file-stage-out --lang`.
- `phase2/organize_stages.py main`: `--graph --skeleton --file-stage --cards-dir --out --workers(8) --lang`.
- `phase2/nav_pack.py main`: `--graph --out(nav_pack.json) --orient` (debug dump).
- `shared/skeleton_yaml.py main`: `bootstrap|render --md --yaml` (md↔yaml conversion).
- `shared/parse_skeleton.py main`: `--skeleton` (prints parsed stage/register/subsystem table).

---

## 2. The IR data model (`ir.py`) and Phase-1 artifacts

### 2.1 Dataclasses

```python
@dataclass FunctionNode:
    id: str                 # "<module_id><sep><qualname>" e.g. "terminus_2.Terminus2._run_agent_loop"
    name: str               # leaf name
    qualname: str           # relative to module, e.g. "Terminus2._run_agent_loop"
    file: str               # path relative to source_root
    line_start: int
    line_end: int
    signature: str
    is_async: bool
    is_method: bool
    class_name: Optional[str]
    decorators: list[str]
    kind: str = "internal"
    synthetic: bool = False          # True for synthesized nodes (e.g. dataclass __init__); lines are 0
    used_self_attrs_read: list[str] = []
    used_self_attrs_written: list[str] = []
    params_types: dict[str, str] = {}   # param name -> resolved type name

@dataclass BoundaryNode:
    id: str                 # "boundary:<qualname>"
    name: str               # leaf segment
    qualname: str           # full dotted path
    module: str             # package/module path without trailing class
    class_name: str         # owning class if method, else ""
    kind: str = "boundary"

@dataclass CallEdge:
    caller_id: str
    callee_id: str          # internal id | "boundary:<qual>" | "unresolved:<hint>"
    is_await: bool
    call_type: str          # self_method | self_attr_method | param_method | internal_func |
                            # internal_constructor | boundary | boundary_constructor | unresolved
    line: int
    raw: str                # source text of the call-expression head, <= 80 chars

@dataclass ModuleAnalysis:
    functions: list[FunctionNode]
    edges: list[CallEdge]   # ALL edges incl. unresolved; partitioning is build_graph's job
```

### 2.2 `phase1/build_graph.py` — assembly + emitters

`build(analysis, *, source_root, scanned_files, out_dir, lang, default_ext, verbose=True) -> stats`:
1. `partition_edges`: `call_type == "unresolved"` → dropped; else kept.
2. `build_node_table(functions, kept_edges, default_ext)`:
   - `nodes[fn.id] = asdict(fn)` for every FunctionNode.
   - degree counts over kept edges: `n_callees` = number of edges with node as **caller**;
     `n_callers` = number of edges with node as **callee**.
   - For every id referenced by an edge but absent from nodes:
     - `boundary:*` → synthesize `BoundaryNode` (qualname split heuristic: first path segment
       starting uppercase becomes `class_name`; before it = module; after = leaf).
     - `*.__init__` → synthesize an init node: `signature="def __init__(self, ...)  # synthesized (no explicit __init__ in source)"`,
       `synthetic: true`, `file = "<module_id><default_ext>"`, lines 0.
3. `build_self_attrs_index(functions)` → `{class_name: {attr: {read_in:[fn ids], written_in:[fn ids]}}}`.
4. Emit four artifacts (see below). `stats = {functions, edges_kept, edges_dropped, internal_nodes, boundary_nodes}`.
   Verbose prints `[build] functions=… kept=… dropped=…`, internal/boundary counts, per-call-type counts, `[done] outputs in <dir>/`.

#### graph.json schema

```json
{
  "metadata": {
    "generated_at": "<ISO8601 UTC>",
    "language": "python|rust|…|multi",
    "harness_dir": "<abs source_root>",
    "scanned_files": ["rel/path.py", "…"],
    "n_internal_functions": 123,
    "n_boundary_nodes": 45,
    "n_edges": 678,
    "policy": "Edges are emitted only when the callee resolves to a named function (internal or boundary). Unresolved/builtin calls live in dropped_calls.json."
  },
  "nodes": {
    "<id>": { /* asdict(FunctionNode|BoundaryNode) + n_callees + n_callers */ }
  },
  "edges": [ { "caller_id": "...", "callee_id": "...", "is_await": false,
               "call_type": "self_method", "line": 42, "raw": "self._foo" } ],
  "self_attrs": { "<Class>": { "<attr>": {"read_in": ["id"], "written_in": ["id"]} } }
}
```

#### functions.csv

Header: `id,name,qualname,file,line_start,line_end,class,is_async,is_method,decorators,signature,n_callers,n_callees,n_self_attrs_read,n_self_attrs_written,unit_id,unit_name,responsibility`.
booleans as `"true"/"false"`, decorators `|`-joined; last 3 columns always empty (legacy compatibility).

#### graph.dot

Graphviz digraph, `rankdir=LR`, rounded boxes, one dashed `subgraph cluster_<i>` per internal file
(fill `#e8f0fe`) plus one `cluster_boundary` (fill `#f0f0f0`). Edge attrs: await → `color="#1a73e8"`;
boundary/boundary_constructor → `style=dashed`.

#### dropped_calls.json

```json
{
  "metadata": {
    "generated_at": "...", "total_dropped": N,
    "by_category": {"builtin": 10, "...": 3},
    "category_explanations": { "inherited_method": "...", "self_attr_unknown": "...",
      "string_literal_method": "...", "builtin": "...", "local_var_method": "...", "bare_name": "..." }
  },
  "edges_by_category": { "<cat>": [ {"caller","callee_raw","is_await","line","raw"} ] }
}
```

`categorize_dropped(callee_id)` on the `unresolved:`-stripped name:
`self.logger.*`/`self._logger.*` → `inherited_method`; other `self.*` → `self_attr_unknown`;
starts with quote → `string_literal_method`; head in `_BUILTIN_NAMES` (len/isinstance/…/exception ctors)
→ `builtin`; contains `.` → `local_var_method`; else `bare_name`.

---

## 3. Phase 1 — adapters

### 3.1 `adapters/base.py` — contract, registry, tree-sitter shim

- `COMMON_SKIP_DIRS = {".git",".hg",".svn","node_modules","vendor","target","build","dist","out","__pycache__",".mypy_cache",".pytest_cache",".ruff_cache",".tox","venv",".venv","env",".env","site-packages",".idea",".vscode"}`.
- `class LanguageAdapter(ABC)`:
  - `name: str`, `extensions: tuple[str,...]`
  - `analyze(files, source_root) -> ModuleAnalysis` (abstract).
  - `statement_spans(file_path, qualname) -> list[(start,end)] | None` — 1-based inclusive statement
    spans inside the named function (legal snap boundaries; default None = unsupported).
  - `discover(source_root)` — default: for each extension, sorted `rglob(f"*{ext}")` skipping any path
    with a component in COMMON_SKIP_DIRS.
- **Registry**: `register(name, factory, extensions)`, `get_adapter(lang)` (KeyError w/ registered list),
  `adapter_for_file(path)` by extension, `available_languages()` sorted,
  `discover_all(root)` → `{lang: files}` for every registered adapter with ≥1 file (exceptions swallowed).
  `_autoregister()` imports each concrete adapter in try/except (missing tree-sitter tolerated).
- **tree-sitter loading**: `get_ts_parser(lang)` — cached; primary `tree_sitter_language_pack.get_parser`;
  fallback standalone `tree_sitter_<lang>` modules (typescript exposes `language_typescript()`);
  clear RuntimeError otherwise.
- **`TSNode`** wrapper normalizes binding differences (`.type` vs `.kind()`, `.start_point` vs
  `.start_position()`): properties `kind,start_byte,end_byte,start_row,end_row,is_named,text,
  child_count,named_child_count`; methods `child(i), field(name), children(), named_children(),
  children_of_kind(*k), first_of_kind(*k), descendants_of_kind(*k)` (pre-order, left-to-right).
- `collect_line_spans(body)` — every named node's 1-based (start,end) span, deduped, sorted (superset
  of statement boundaries; used by statement_spans in TS adapters).
- `parse_tree(lang, source)` — parses bytes/str (tries both), returns wrapped root.

### 3.2 `python_adapter.py` (stdlib `ast`; most precise)

Two passes.

**Pass 1 — `_ModuleScanner(ast.NodeVisitor)` per file** (`module_id` = rel path minus `.py`):
- imports: `import a.b as c` → `imports["c"]="a.b"`; `from m import x as y` → `imports["y"]="m.x"`.
- classes: pushes class stack, records `module_classes`; methods recorded in `class_methods[cls]`.
- functions (incl. async, incl. **nested** defs which are also recorded as their own nodes with
  qualname `outer.inner`): builds FunctionNode with:
  - qualname combination of class stack + function nesting stack.
  - signature `def|async def name(<ast.unparse(args)>)[ -> ret]`.
  - `is_method` = has class, not nested, not `@staticmethod`.
  - self-attr reads/writes via `_SelfAttrTracker` (Assign/AugAssign/AnnAssign targets → writes;
    `self.X` loads → reads; AugAssign counts both; skips nested function/lambda bodies).
  - `params_types` from annotations: unwraps `Optional[T]`/`T | None`; drops generic builtins
    (str/int/float/bool/…/Any); resolves through the import table (`imports.get(type_name, type_name)`).
  - per-function local imports collected into `local_imports[node_id]`.
- `self_attr_types[(class, attr)]` learned from method bodies (deferred to `finalize()`):
  `self.x = SomeClass(...)` → attr type = resolved class name; `self.x = self.make_y()` →
  type from that method's return annotation if it's a single clean name (no `[]|, ` chars) and not builtin.
- `_method_returns[(class, method)]` = return annotation text.

**Pass 2 — `_CallExtractor`** with `class_to_module` (bare class name → module id, first seen wins);
walks every recorded FunctionNode's AST (via `function_ast_index[(file, lineno, name)]`; KeyError skips
that function) using `_iter_calls` which yields `(parent, Call node, is_await)` — nested defs/lambdas are
skipped (own scope); default arg expressions of the target function are also walked; a Call directly
under Await gets `is_await=True`; calls nested inside a call's args get `is_await=False`.
Resolution (imports = module imports ∪ function-local imports; function-local wins):

- **A. bare `Name()`**: local class → `internal_constructor` to `<mod>.<Class>.__init__`; local function
  → `internal_func`; imported name: if last segment starts uppercase — internal class in another module
  → cross-module `internal_constructor`, else `boundary_constructor boundary:<qual>`; if import's root
  package is one of the scanned module ids → `internal_func` to `<qual>`; else `boundary`. Otherwise
  `unresolved:<name>`.
- **B1. `self.foo()`**: method on own class → `self_method` `<mod>.<cls>.<attr>`; else `unresolved:self.<attr>`.
- **B2. `self.attr.foo()`**: attr type known → internal class module → `self_attr_method`; known but not
  scanned → `boundary:<type>.<attr>`; unknown → `unresolved:self.<attr>.<foo>`.
- **B3. `Base.foo()` where Base is a Name**: caller param with that name typed → `param_method`
  (internal) or `boundary:<ptype>.<attr>`; Base in imports: if Base is a scanned class →
  `internal_func` `<mod>.<Base>.<attr>` else `boundary:<qual>.<attr>`; else `unresolved:<base>.<attr>`.
- **C.** anything else → `unresolved:<raw>` (raw = `ast.unparse(func)` truncated at 80 with `...`).

`statement_spans`: parses the file, strips leading qualname parts not found among top-level names,
finds the function (top-level or one level inside a class), collects `(lineno, end_lineno)` of every
`ast.stmt` in its body (recursive), sorted set. Returns None on SyntaxError / not found.

### 3.3 `rust_adapter.py` (tree-sitter)

- `_SKIP_DIRS = {"target",".git","node_modules"}`; extensions `(".rs",)`; custom discover.
- `_GENERIC_TYPES`: numeric primitives, bool/char/str/String, Vec/Box/Option/Result/HashMap/HashSet/
  BTreeMap/Rc/Arc/RefCell/Cell/Mutex/RwLock/Cow — excluded from param/field typing.
- `module_id`: rel path minus `.rs`, split on `/`, drop `mod`/`lib`/`main` segments, join with `::`
  (fallback: raw stem with `/`→`::`).
- Scan (per-file `_RustModule`): `use` declarations (scoped identifiers, `use…as`, use-lists, nested;
  wildcards ignored) → `imports[local]=full::path`; structs/unions → `type_names` + field types
  (peeling refs/generics/scoped paths via `_core_type_name`); enums → type_names; traits → type_names +
  default methods (declarations without body skipped); impl blocks → methods (owner = impl type);
  `mod name { … }` recursed with `prefix="name::"`; attribute_items accumulate as decorators for the
  next item. Function nodes: id `= <module_id>::<prefix><Owner>::<name>` or `<module_id>::<prefix><name>`;
  `is_async` from `function_modifiers` containing "async"; signature `("async " )fn name(params)[ -> ret]`;
  self-attr reads = `self.field` field_expressions; writes = assignment/compound-assignment LHS
  field_expressions on self; `params_types` from typed parameters. Bodies retained for pass 2.
- **Module merging**: sibling files collapsing to one module_id (lib.rs/main.rs/mod.rs) are merged
  (first-seen wins on duplicate function ids) rather than overwritten.
- Cross-module indexes: `type_to_module` (bare type → module, first wins) and a free-function index
  `by_modtail_name[(module_tail, fn_name)] -> {ids}` — resolution only when **unique**.
- Call resolution `_iter_calls` (skips nested fn/closure bodies; `.await` sets is_await;
  `macro_invocation` yielded as call):
  - macros → `boundary:<name>!` edge with call_type boundary.
  - bare identifier: local free fn → `internal_func`; imported: local type name → `internal_constructor`
    `<tmod>::<name>::new`; else resolve imported free fn via unique (tail,leaf) → `internal_func`, else
    `boundary:<qual>`; else `unresolved:<name>`.
  - `scoped_identifier` (`A::b`): owner is scanned type → `<tmod>::<Owner>::<leaf>` with
    `internal_constructor` when leaf ∈ {new, default, from} else `internal_func`; else unique free-fn
    lookup → `internal_func`; else `boundary:<path>` with `boundary_constructor` when owner is
    capitalized and leaf ∈ {new, default, from}.
  - field_expression: `self.m()` → self_method if m in own type's methods, else `unresolved:self.m`;
    `self.field.m()` → field type known → `self_attr_method`/`boundary`; `x.m()` with typed param →
    `param_method`/`boundary`; else unresolved.
- `statement_spans`: find `function_item` whose name equals last `::` segment; `collect_line_spans(body)`.

### 3.4 `typescript_adapter.py` (tree-sitter; `.ts`/`.tsx`, skips `.d.ts`; skip dirs node_modules/.git/dist/build)

- `_GENERIC_TYPES`: number/string/boolean/any/unknown/void/never/object/Array/Promise/Map/Set/Record/Date/Object.
- module_id = rel path minus extension, `/`→`.`.
- Scan: unwraps `export_statement`; `import {X as Y} from "src"` → `imports[Y]="src::X"`; namespace
  import → `imports[ns]="src"`. Classes: methods recorded (constructor also mines
  parameter-properties into field_types); class fields: arrow/function-expression valued fields are
  recorded **as methods** (nodes + edges); typed plain fields → field_types. Top-level
  `function_declaration` and `const helper = (…) => {…}` → free functions. Signature = declaration
  text up to the body start (`[:200]`). self attrs = `this.X` member expressions (reads) /
  assignment LHS (writes).
- Resolution mirrors Rust at `.`-separator: identifier → internal_func | boundary(import) | unresolved;
  member_expression: `this.m()` → self_method/unresolved; `this.field.m()` → self_attr_method/boundary/
  unresolved; `param.m()` → param_method/boundary; `imported.m()` → `boundary:<import>.<m>`; else unresolved.
- `_iter_calls` skips nested function scopes, tracks `await_expression`.
- `statement_spans`: function_declaration/method_definition by leaf name, or arrow/function-expression
  bound to a matching field/variable name.

### 3.5 `go_adapter.py` (tree-sitter; `.go`; skips `vendor`, `.git`, `*_test.go`)

- `_GENERIC_TYPES`: Go numerics, byte/rune/string/bool/error/any.
- module_id = rel path minus `.go`, `/`→`.`.
- Scan: imports (`import a "pkg"` → local name a or path basename); type declarations →
  type_names + struct field types (peeling `*T`, `[]T`, qualified `pkg.T`);
  `func F()` → free function; `func (r *T) M()` → method of T with receiver var r. `is_async` always false.
- Resolution: identifier → internal_func/unresolved; selector_expression: `r.M()` (receiver) →
  self_method/unresolved; `r.field.M()` → self_attr_method/boundary/unresolved; `param.M()` →
  param_method/boundary; `pkg.F()` for imported pkg → `boundary:<import path>.<F>`; else unresolved.
- `_iter_calls` never sets is_await; skips func_literal / nested declarations.

### 3.6 `scripting_adapters.py` — Starlark / Shell / PowerShell

Free-function model only (no classes). Shared `_ScriptAdapter`:
- one FunctionNode per function definition (`fn_kind` per language); id `= <module_id><sep><name>`
  (sep `"."`); signature = text up to body (or first line), `[:200]`.
- Global `name_to_module` across scanned files (first wins). Every call:
  name defined anywhere → `internal_func` edge; else `boundary:<name>` (real dependency info like
  "this script calls git/cargo").
- `StarlarkAdapter`: exts `.star,.bzl,.bazel`; ts grammar "starlark"; fn_kind `function_definition`;
  calls = `call` nodes; callee name = last `.`-segment of the function expression.
- `_CommandAdapter` (Shell + PowerShell): calls = `command` nodes' `command_name`; first whitespace
  token; `/usr/bin/git` → `git`.
- `ShellAdapter`: exts `.sh,.bash`; grammar `bash`; fn_kind `function_definition`.
- `PowerShellAdapter`: exts `.ps1,.psm1,.psd1`; grammar `powershell`; fn_kind `function_statement`;
  name via field `name` or first `function_name`; body via field `body` or first `script_block`.

---

## 4. shared/

### 4.1 `api_client.py` — OpenAI-compatible LLM client

**Env resolution** (module import time):
- `DEFAULT_MODEL = $OPENAI_MODEL || $HANDBOOK_LLM_MODEL || "gpt-4o-mini"`
- `DEFAULT_BASE_URL = ($OPENAI_BASE_URL || $HANDBOOK_LLM_BASE_URL || "https://api.openai.com/v1").rstrip("/")`
- `DEFAULT_API_KEY = $OPENAI_API_KEY || $HANDBOOK_LLM_API_KEY || ""`
- `DEFAULT_MAX_TOKENS = int($OPENAI_MAX_TOKENS || $HANDBOOK_LLM_MAX_TOKENS || 16000)`
- Retries: `max_retries = int($HANDBOOK_LLM_MAX_RETRIES || 6)`, `retry_backoff_sec = float($HANDBOOK_LLM_RETRY_BACKOFF || 3.0)`.

`Api(host=None, port=None, user=None, apikey=None, model_marker=DEFAULT_MODEL, request_timeout=3600,
call_timeout=6000, max_retries, retry_backoff_sec, base_url, api_key, max_tokens)`:
- `base_url` becomes `<base>/chat/completions`. host/port/user/apikey accepted but unused (back-compat).
- Missing key → `EnvironmentError` at construction ("set OPENAI_API_KEY … For a keyless local endpoint, set OPENAI_API_KEY=EMPTY").
- `openai_mode = True` attribute kept for introspection.

`call(prompt, params=None) -> LLMCallResult`:
- Single-turn: `messages=[{"role":"user","content":prompt}]`.
- **Reasoning-model detection**: regex `gpt-5|gpt-4\.1|o[1-9]` (case-insensitive) on model name →
  use `max_completion_tokens` and **omit** `temperature`; classic models use `max_tokens` and accept
  `params["temperature"]` if provided.
- Retry loop 1..max_retries: POST with `requests`, timeout=request_timeout.
  - non-200: log warning; **permanent** client errors `400,401,403,404,405,410,422` raise immediately
    (no more retries); 408/429/5xx stay in the loop.
  - exception: logged, retry.
  - between attempts: sleep `retry_backoff_sec * attempt + uniform(0, 0.5)` (linear backoff + jitter).
  - all attempts fail → `RuntimeError("LLM call failed after N attempts: <last>")`.
- On 200: `_extract_assistant_text` tries in order: `choices[0].message.content`,
  `data.choices[0].message.content`, `data.response`, `response`, `result.content`, `data.content`,
  `text`; else returns pretty-printed body. Then `_extract_json_block(text)`:
  1. every ```json (or bare ```) fenced block, first parseable wins;
  2. fallback: first balanced `{…}` scan (string/escape aware), advancing to the next `{` on parse failure.
- Result: `LLMCallResult(raw_text, status_code, request_id=uuid4, elapsed_sec, parsed_json, error)`;
  `error="no JSON block found"` when parsed_json is None.

### 4.2 `critic.py` — Actor-Critic framework

**Role prompts** `ROLE_PROMPTS` (verbatim intent, abridged here):
- `engineer` — "You are a SENIOR ENGINEER reviewing a proposed change … be skeptical and find real
  concerns rooted in code behavior." Focus: classification vs actual code, line ranges sound,
  misuse of cross-cutting categories, caller/callee consistency.
- `architect` — "You are a SYSTEM ARCHITECT … find structural problems." Focus: clean stage
  boundaries, bloat (>20 members) / starvation (<2), subsystem boundaries, genuine multi-identity.
- `reader` — "You are a TECHNICAL WRITER / HANDBOOK EDITOR … ensure the change makes the handbook
  MORE READABLE." Focus: cohesive stage pages, intuitive titles/IDs, narrative regions, no surprises.
- `editor` — "You are a NARRATIVE EDITOR reviewing a proposed ORDERING of members within one stage."
  Focus: structure (linear/branched/unordered) matches content.
Each ends "You may APPROVE, REVISE (with concrete concerns), or REJECT."

**Critic output rules** (`_CRITIC_OUTPUT_RULES`, appended to every critic prompt): APPROVE generously
("A correct-enough proposal is APPROVE, not REVISE"), REVISE only for specific actionable flaws
materially affecting correctness, REJECT only when unfixable; must return one JSON block:

```json
{"decision":"APPROVE|REVISE|REJECT","concerns":["..."],"suggested_revision":{...}|null,"rationale":"..."}
```

**Data types**: `Verdict(decision, concerns, suggested_revision, rationale)` with is_approve/is_revise/
is_reject; `ActorCriticResult(final_proposal, rounds, actor_proposals, critic_verdicts, accepted)`.

**`_normalize_vacuous_revise`**: REVISE with empty concerns → coerced to APPROVE (warn-logged,
rationale prefixed `[normalized from vacuous REVISE]`).

**`build_critic_prompt(role, task_context, proposal, schema_hint, review_evidence)`**: role block,
`## Task context`, optional `## Review evidence (ground truth for judgement)`,
`## Proposal under review` (fenced JSON), optional `## Proposal schema reminder`, output rules.

**`build_revise_prompt(actor_prompt, original_proposal, verdict)`**: original prompt +
`── PREVIOUS PROPOSAL (under review) ──` (fenced JSON) + `── REVIEWER'S CONCERNS ──` bullets +
optional `── REVIEWER'S SUGGESTED REVISION ──` + instruction to address every concern and return the
same schema.

**`parse_verdict(parsed_json) -> (Verdict|None, error_reason|None)`**: strict — dict-shaped, decision a
string in the canonical set (uppercased/stripped), concerns list-coerced, `suggested_revision` must be
dict or null (else rejected with reason).

**`call_actor(api, prompt)`** → parsed_json or None (exceptions warn-logged).
**`call_critic(api, role, …)`** → Verdict or None; parse failures logged with reason + 300-char raw preview.

**`actor_critic_loop`** (1 critic, ≤2 rounds): actor → critic; APPROVE→accept v1; REJECT→discard;
REVISE→revise prompt→v2→critic with round-2 context note ("this is round 2 … judge whether the revision
addresses these concerns"); after 2 rounds accept unless REJECT (lingering REVISE ships v2).
Broken critic (None) → conservative discard.

**`actor_multi_critic_loop`** (N critics serial; used conceptually by Pass C): all critics review v1;
all-APPROVE→accept; else aggregate concerns as `[role] concern` list into a synthetic REVISE verdict,
actor revises once; round-2 per-critic context includes that critic's own round-1 verdict; accept iff
no round-2 REJECT. Broken critic = REJECT verdict `critic_call_failed`.

**`summarize_result(result, label)`** → `"<label>: ACCEPTED after N round(s) (M critics)"` or
`"<label>: DISCARDED (…decisions…)"` / `"<label>: actor_failed"`.

### 4.3 `progress.py`

`fmt_dur(secs)` → `"12s"`/`"3m05s"`/`"1h02m"`.
`Progress(logger, label, total)`: `tick(weight=1.0, note="")` logs
`[label done/total · P%] note · elapsed E · ETA T` with linear-extrapolation ETA; `finish()` logs
`[label done] N unit(s) in D`.

### 4.4 `skeleton_yaml.py` — canonical skeleton form

SkeletonDoc shape:
```yaml
metadata: {version: 1, ...}          # + archetype / drafted_by
stages:
  - {id: stage-1, title: "...", description: "...", parent: null, children: [stage-1.1], crosscut: false}
state_registers: []                   # populated only by legacy md; Phase 3 re-extracts
subsystems: []
unread_regions: []                    # from synth_stages._normalize
```

- `save_yaml(doc, path)`: custom SafeDumper — multi-line strings emitted as `|` block scalars;
  short scalar lists (≤8 items, each ≤40 chars) flow-style; anchors/aliases disabled; sort_keys=False,
  allow_unicode, width=10000. Parent dirs created.
- `load_yaml(path)` = `yaml.safe_load`.
- `convert_md_to_yaml(md, yaml)` (one-time bootstrap): parse_skeleton → parents inferred from id
  suffix `.N` when the prefix exists (stage-4.1 → stage-4); state_registers `{id, semantics}`;
  subsystems `{id, role}`; metadata `{version:1, generated_from:<mdname>}`.
- `render_md_from_yaml(doc, md)`: structural render — header `# Terminus 2 Harness — Skeleton`,
  autogen note, `## Main Flow` (parentless non-side/crosscut, recursive H(level) with backticked id),
  `## Side Flows` (side-* parentless), `## Cross-cutting Concerns` (crosscut-*),
  `## State Registers` and `## Subsystems` as `| ID | Semantics/Role |` tables.
- Helpers: `stage_ids(doc)`, `stage_by_id(doc, sid)`, `stage_short_descriptions(doc)` →
  `{sid: "<title>: <first sentence of description>."}` (split on `". "`).

### 4.5 `parse_skeleton.py` — skeleton.md parser (legacy input path)

- Recognizes headings `^#{2,4} ` containing a backticked id matching prefixes
  `stage-|side-|crosscut-`; heading title = heading text minus the backticked id, minus a leading
  `Stage|Sub-stage|Side Flow|Cross-cut` word and em-dash. Description = first paragraph after the
  heading (stops on blank-after-content, tables, `---`).
- `## State Registers` and `## Subsystems` markdown tables mined for `reg-*` / `subsys-*` ids;
  semantics/role = last cell of each row (2-cell tables).
- Types: `StageEntry(stage_id,title,description)` with `.short()` = `"id — title: first-sentence."`;
  `SkeletonTable(stages, registers, subsystems)` with `stage_ids/register_ids/subsystem_ids` and
  `to_prompt_block()` (stage menu + subsystem refs for prompts).

---

## 5. Phase 2

### 5.0 `nav_pack.py` — graph-derived navigation pack (no LLM)

`build_nav_pack(graph, fan_out_top_k=40, sample_fns_per_file=8)` over internal non-synthetic nodes:

```json
{
  "language": "...", "source_root": "...",
  "totals": {"n_files": N, "n_functions": N, "n_dirs": N, "n_external_subsystems": N},
  "dir_map": {"<dir>": {"n_files": n, "n_functions": n}},                // sorted
  "files": [{"file","dir","n_functions","classes":[...],
             "sample_functions":[{"qualname","signature"(<=120),"line_start"}]}],
  "entry_points": [{"qualname","file","line_start","n_callees","is_root"}],
  "fan_out_top": [{"file","out_degree"}],                                // top-K by summed n_callees
  "external_subsystems": [{"module","n_calls_into","sample":[<=5 quals]}]
}
```

- Entry points = roots (internal nodes with `n_callers == 0` and a line_start) ∪ name-heuristic hits
  (name equals or `startswith(hint+"_")` for hints main/run/serve/start/execute/exec/dispatch/handle/
  handler/cmd/command/app/loop/bootstrap), deduped by qualname, sorted by `(-n_callees, qualname)`.
- `all_file_descriptors(graph, nav)` widens `nav["files"]` with `metadata.scanned_files` entries that
  have no functions: `{file, dir, n_functions:0, classes:[], sample_functions:[]}` — the 1:1 file set
  used by 2a cards and 2b assignment.
- `render_orientation(nav, max_dirs=120, max_entries=25, max_ext=30)` — bounded text block:
  `SYSTEM: language=… files=… functions=… dirs=…`, `## Directory map`, `## Entry-point candidates`
  (`[root|hint] qualname file:line →N callees`), `## Highest fan-out files`, `## External subsystems`.

### 5.1 Phase 2a — `read_files.py` (read every file → cards)

**Role vocabulary** (constrained; the model must pick one, invalid → coerced to `other`):
`entrypoint, orchestration, domain_logic, io_transport, data_model, config, util, test, generated, other`.

**Prompts** — four rule templates chosen by `(detail, lang)`:
- `_RULES` (brief EN): "You are reading SOURCE FILES one by one and writing a short, plain-language
  PURPOSE for each, to drive a system handbook meant for a curious NON-EXPERT reader." Each file: path
  + head excerpt. Return per file `purpose` (1-2 plain sentences), `role` (exactly one of the enum,
  with one-line glosses per role), `lifecycle` (short hint: "startup", "config load", "main loop",
  "request handling", "turn execution", "teardown", "cross-cutting", "none"). Output ONLY:
  ```json
  {"purposes":[{"file":"<exact path>","purpose":"...","role":"<role>","lifecycle":"..."}]}
  ```
- `_RULES_DEEP` (deep EN): "You are reading SOURCE FILES IN FULL and writing a plain-language,
  easy-to-follow description of each, for a system handbook in which the FILE is the smallest unit
  (its leaf node). The description you write IS the handbook's content for this file." Extensive
  style guidance (plain language, explain WHY/WHAT before mechanism, explain jargon inline first use,
  everyday analogy welcome, no implementation trivia, accurate, no filler like "handles").
  Notes that each file comes with its graph-derived FUNCTION LIST (qualname + line range) whose
  inventory/lines/call relations are FACTS — "do NOT re-list them". Per file return: `purpose`,
  `description` (~120–300 words walkthrough), `functions` (one per listed function, referenced by exact
  `qualname`, each with `purpose` (1-3 sentences), `data_flow` (IN → transform → OUT story),
  `relations` (who calls it and when / what it hands off, grounded in the provided calls/called-by
  facts)), `role`, `lifecycle`. Output schema adds `description` + `functions[]`.
- `_RULES_ZH` / `_RULES_DEEP_ZH`: same JSON schema and same **English** role-enum values; all prose
  values in Chinese ("JSON 的 key 用英文，值用中文"). Deep-ZH mirrors the deep-EN structure with
  Chinese writing guidance (大白话, short sentences, explain terms, one analogy, 120–300 字).

**`build_inventory(graph, rel_cap=25)`** — deterministic per-file function inventory:
For internal non-synthetic nodes with a line_start; over edges with internal caller (self-loops skipped):
internal→internal edges keyed by node id feed `calls`/`called_by`; edges to non-internal targets record
the **target qualname** (or `boundary:`-stripped id) into `ext_calls` (honest about unresolved).
Returns `{file: [{id, qualname, name, class_name, line_range:[a,b], signature(<=200),
calls[:25], called_by[:25], ext_calls[:25], n_calls, n_called_by, n_ext_calls}]}`, functions sorted by
line_start. Relations keyed by node id (not qualname) because Rust free functions share bare names.

**Prompt assembly**: per file `### FILE: <rel>  (N fn)  classes=[...]` + fenced full source (or head
excerpt with `... (truncated, N chars total)` if `max_chars>0`); deep mode appends
`#### Functions to annotate (reference each by its qualname; call facts from the graph):` with lines
`  - qualname  (lines a-b)` / `      calls: name, name (+K more)` / `      called by: …` (leaf names,
cap 8). Batch prompt = rules + `## Files to describe (N)` + blocks + "Return the JSON block only…".

**`_describe_batch`**: one `api.call(prompt, {"temperature": 0.0})`; on exception/no-dict → `{}`.
Parses `purposes[]`; entries with `file` not in the batch are dropped; role validated; deep entries get
`description` + `functions = _merge_function_notes(inventory[file], llm_functions)`.

**`_merge_function_notes(graph_funcs, llm_funcs)`**: index LLM annotations by qualname then by name;
tolerate legacy `note` field folded into purpose; every graph function gets
`{**graph_fields, purpose, data_flow, relations}` (empty strings when unmatched) — inventory is always
complete, prose best-effort.

**Three-tier degradation `_describe_batch_safe`**:
1. whole batch in one call;
2. any dropped file retried **alone** (only if batch size > 1);
3. deep only: still-failing file → `_describe_file_chunked`: greedily group its functions so each
   chunk's combined source (by graph line ranges) ≤ `chunk_chars`; per-chunk prompt = deep rules +
   `## File (too large for one pass — processing a CHUNK of its functions): <rel>` + per-function
   `#### qualname (lines a-b)` + calls/called-by ground lines + fenced function source +
   "Return ONE entry for <rel> covering exactly these functions."; merge: first purpose/role/lifecycle
   wins, descriptions concatenated with spaces, all llm function annotations merged onto full inventory.
   Failures per chunk are logged and skipped; base entry (empty prose, full inventory) survives.

**Card persistence**: card path mirrors the source tree — `cards/<rel>.json` (e.g.
`cards/app-server/src/lib.rs.json`). Written immediately per batch on the **main thread**:
`{"file": rel, **entry}` pretty JSON. Write failures (OSError, e.g. path length) logged, non-fatal.

Card schema (deep):
```json
{
  "file": "core/src/session.rs",
  "purpose": "…", "role": "domain_logic", "lifecycle": "main loop",
  "description": "…120-300 words…",
  "functions": [{
     "id": "core::session::Session::run", "qualname": "Session::run", "name": "run",
     "class_name": "Session", "line_range": [40, 118], "signature": "async fn run(&mut self) -> Result<()>",
     "calls": ["core::session::Session::step"], "called_by": ["main::main"], "ext_calls": ["tokio::spawn"],
     "n_calls": 1, "n_called_by": 1, "n_ext_calls": 1,
     "purpose": "…", "data_flow": "…", "relations": "…"
  }]
}
```
Brief cards omit `description`/`functions`.

**`load_cards(cards_dir)`**: recursive `rglob("*.json")`; JSON parse failures skipped; identified by the
`"file"` key (so `_coverage.json` is skipped naturally); returns `{rel: card-without-file-key}`.

**`_is_done(card, detail)`** (resume filter): needs non-empty `purpose`; deep additionally needs a
non-empty `description` OR ≥1 function with a purpose. Brief cards don't satisfy deep resume.

**`read_purposes(api, graph, source_root, *, cards_dir, batch_size=8, max_workers=6,
max_chars_per_file=6000(lib default; run.py passes 0), detail="brief", chunk_chars=60000, resume=False,
lang="en")`**:
1. nav pack; files = all_file_descriptors (1:1 with source tree).
2. deep → build inventory.
3. resume: load existing cards, keep `_is_done` ones, log `resume: D/T files already done, R to process`.
4. slice into batches; ThreadPoolExecutor(max_workers); per-completed-batch: merge results, write cards
   (main thread), `Progress.tick(note="<n> files described")`.
5. **Backfill**: every file with no result gets `{"purpose":"","role":"other","lifecycle":"none"}`
   (+ empty description + graph-only functions in deep) and is written as a card; recorded in
   `coverage.missing`.
6. Write `cards/_coverage.json` = `{"n_files": total, "n_described": total-missing, "missing": sorted}`.
7. Return `{"file_purposes": {...}, "coverage": {...}}`.

### 5.2 Phase 2b step B — `file_assign.py` (file→stage, batched)

**Prompt `_RULES`**: "You are assigning whole SOURCE FILES to stages of a system handbook." Pick the
ONE stage whose description best matches the file's primary responsibility; cross-cutting utilities →
best-fit crosscut stage. Rules: `stage` MUST be a menu ID (never invent), assign by PRIMARY identity,
optional `also` (0-2 extra IDs, only genuine spans, don't pad), genuinely-nowhere files (generated/
vendored/dead) → `"unassigned"`. Output:
```json
{"assignments":[{"file":"<exact path>","stage":"<stage-id|unassigned>","also":[]}]}
```

Batch prompt = rules + `## Stage menu (valid IDs)` (from `stage_short_descriptions`) +
`## Files to assign (N)` + per-file descriptor:
```
- <file>  (N fn)  classes=[...]
    purpose: <card purpose>  [role=…, lifecycle=…]      # only when purposes provided
    fns: qual sig; qual sig; …                          # up to 8 samples, or "(none sampled)"
```

`_assign_batch`: temperature 0.0; invalid stage ids coerced to `unassigned`; `also` filtered to valid
ids; files not in the batch or dropped by the LLM are omitted (caller backfills).

`assign_files(api, graph, skeleton_doc, *, batch_size=25, max_workers=6, purposes=None)`:
files = all_file_descriptors; ThreadPool over batches with Progress ticks; backfill dropped/unassigned;
returns:
```json
{
  "file_stage": {"<file>": {"stage": "stage-3", "also": []}},
  "buckets":    {"<stage-id>": ["file", ...]},          // primary stage only; disjoint
  "coverage":   {"n_files": N, "n_assigned": M, "unassigned": ["file", ...]}
}
```

### 5.3 Phase 2b step A + loop — `synth_stages.py` / `synth_agent.py`

#### `synth_stages.synthesize_skeleton` (oneshot draft)

- `_dir_rollups(file_purposes, files, examples_per_dir=4)`: group by dir; per dir:
  `{dir, n_files, roles: {role: count} (most-common order), lifecycles: top-3 lifecycle strings,
  examples: up to 4 non-empty purposes sorted longest-first}`.
- Rendered as `- <dir>  (Nf) roles=[role×n, …]; lifecycle=a/b` + `    · <example>` lines.
- **Prompt `_SYNTH_RULES`** (EN; `_SYNTH_RULES_ZH` mirrors with Chinese title/description values):
  "You are dividing a large codebase into the STAGES of a system handbook, using a per-directory
  rollup of file purposes plus the call-graph entry points. Produce the high-altitude NARRATIVE SPINE…"
  Rules: order main stages by EXECUTION/LIFECYCLE not alphabetically (entry points → setup → dispatch →
  main loop/request handling → per-unit work → teardown; use the lifecycle hints); aim **12–25 top-level
  stages**; use substages (`parent`, ids like `stage-3.1`) for depth; genuinely cross-cutting infra
  (logging/telemetry, config, protocol/types, generic utils, persistence) → `"crosscut": true` after the
  main flow; every rollup dir must be coverable; descriptions concrete enough for later file assignment.
  Output:
  ```json
  {"metadata":{"archetype":"<one phrase>"},
   "stages":[{"id":"stage-1","title":"...","description":"...","parent":null,"crosscut":false}]}
  ```
- Full prompt = rules + `## System: language=… files=… dirs=…` + `## Entry-point candidates` (top 25:
  `[root|hint] qualname file:line →N callees`) + `## Directory rollup (N dirs …)` + rendered rollups.
- temperature 0.0; no usable `stages` → RuntimeError.

#### `_normalize(raw)` → canonical SkeletonDoc

Every stage coerced to `{id,title,description,parent,children,crosscut}`; missing id → `stage-<i>` or
`crosscut-<i>`; duplicate ids suffixed `-<i>` until unique; description defaults to title; dangling
parents nulled; `children` rebuilt from parents; wraps in
`{"metadata": {**raw.metadata, "version":1, "drafted_by":"synth_stages"}, "stages": […],
"unread_regions": [], "state_registers": [], "subsystems": []}`.

#### `synth(api, graph, file_purposes, *, assign_workers=6, assign_batch_size=25,
synth_mode="oneshot", max_rounds=6, doctor_workers=1, doctor_llm_workers=None, lang="en")
→ (skeleton_doc, assign_result)`

- `oneshot`: synthesize_skeleton → assign_files (purpose-aware) once.
- `agent` / `doctor`: delegate to `synth_agent.synth_agent_loop(..., use_agent_draft=(mode=="agent"))`.

#### `synth_agent.py` — draft agent + convergence loop

**Step A draft (agent mode)** — NexAU agent (`nexau` package):
- Env required: `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` (EnvironmentError otherwise); optional
  `LLM_API_TYPE` (default `openai_chat_completion`), `LLM_TEMPERATURE` (0.0), `LLM_MAX_TOKENS` (8000),
  `LLM_EXTRA_BODY` (JSON), `NEXAU_TOOL_CALL_MODE` (structured), `SYNTH_AGENT_MAX_ITERS` (12),
  `LLM_MAX_CONTEXT` (200000).
- System prompt `_DRAFT_SYSTEM_PROMPT` (EN/ZH): the same synthesis guidance restated for an agent, with
  workflow: (1) call `get_orientation` FIRST — "This is your only source of truth… you cannot read
  individual files"; (2) reason about lifecycle order; (3) call `propose_skeleton` ONCE; (4) one-line
  summary and stop. Emphasizes "This is a SHALLOW FIRST DRAFT" — a later automated step assigns and
  enriches.
- Two closure-bound tools loaded from YAML descriptors in `phase2/agent_tools/`:
  - `get_orientation` (no args, idempotent) → the prebuilt `nav_pack.render_orientation` text.
  - `propose_skeleton(stages, metadata)` → validates non-empty list; normalizes via
    `synth_stages._normalize`; stores in shared `state["skeleton_doc"]`; returns confirmation
    (stage count + ids) or `{content, error:{message,type}}` on bad input. Tool YAML input schema:
    stages[] items require `id,title,description`, optional `parent` (string|null), `crosscut` (bool);
    metadata may carry `archetype`.
- Task message: "Divide this codebase into the ordered stages of a system handbook. Call
  get_orientation, then call propose_skeleton with your draft."
- Any failure OR no recorded skeleton → **fallback** to oneshot `synthesize_skeleton` (warn-logged).

**Loop `synth_agent_loop(api, graph, file_purposes, *, max_rounds=6, assign_workers=6,
assign_batch_size=25, doctor_workers=1, doctor_llm_workers=None, use_agent_draft=True, lang="en")`**:
1. `doctor_llm_workers = doctor_llm_workers or max(assign_workers, doctor_workers, 3)`;
   `doctor.set_llm_concurrency(n)` (global semaphore).
2. Draft: agent (mode=agent) or oneshot (mode=doctor).
3. First full `assign_files`.
4. Up to `max_rounds` rounds:
   - snapshot `n_unassigned_before`, `n_overloaded_before` (from doctor stats).
   - `doctor.run_doctor_files(api, skeleton_doc, assign_result, purposes, doctor_workers, lang)` —
     mutates skeleton in place, returns
     `{skeleton_changed, affected_files, n_applied, n_proposed, n_rejected, summary}`.
   - If changed: `reassign_subset(affected ∪ still-unassigned)` → fresh assign_result.
   - **Converged**: 0 unassigned AND no skeleton change this round → break.
   - **Stuck detection**: progress = unassigned decreased OR overloaded-stage count decreased.
     Two consecutive no-progress rounds → warn + break (residual files stay unassigned).
5. If loop exhausts with unassigned files → warning; they remain in the `unassigned` bucket.
Returns `(skeleton_doc, assign_result)` — same shapes as oneshot.

### 5.4 `skeleton_doctor_files.py` — the file-level skeleton doctor

Constants: `_OVERLOAD_HINT = 20`; `_CRITIC_ROLES = ["engineer","architect","reader"]`;
module-global `_LLM_CONCURRENCY = 12` semaphore (BoundedSemaphore), reset by `set_llm_concurrency(n)`;
every LLM call in the module goes through `_with_llm_cap(thunk)` which captures the semaphore instance
once (so a mid-flight rebind can't over-release).

**`compute_file_stage_stats(skeleton_doc, assign_result)`**:
`overload_floor = max(20, 2.5 × mean non-empty bucket size)`; a stage is `overloaded` iff its file count
> floor (dominant-dir share reported as a hint but not required). Returns
`{"per_stage": {sid: {n_files, dir_distribution, dominant_dir, dominant_dir_share, overloaded}},
"n_unassigned", "unassigned": [...], "n_files"}`.

**`_render_stats`** (shared ground truth for actor AND critics): header
`Skeleton: N stages, M files total, U UNASSIGNED.`, `## Current skeleton`
(`id parent=… children=n [crosscut] — first-sentence[:80]` rows), `## File distribution per stage`
(`sid files=n dom dir: d (k/n = p%) <OVERLOAD?>` rows), `## Unassigned files (these MUST be given a home)`
(up to 40 files with purposes, `... and N more`).

**Actor prompt `_ACTOR_RULES`** (single global actor; ZH appends `_ZH_NOTE` telling the model to write
new titles/descriptions in Chinese while keys/ids/actions/paths stay unchanged):
"You are the SKELETON DOCTOR for a system handbook. The handbook's leaf node is the SOURCE FILE…
Propose **at most 3** structural changes…". Priorities: (1) UNASSIGNED FILES → `add_stage` for a
coherent group OR widen an existing stage; (2) STAGE OVERLOAD (`<OVERLOAD?>` flag, dom-dir share) →
`split_stage`; (3) STARVATION (sibling substages with 0–1 files) → `merge_stages`; (4) DEAD STAGES →
`remove_stage`. Anti-guidance: no cosmetic splits/merges, don't touch healthy stages, ≤3 changes,
prefer widening scope over near-duplicate stages. Action schemas (members are FILE PATHS):

```json
{"action":"add_stage","new_stage":{"id":"…","title":"…","description":"…","parent":"<id|null>","crosscut":false},
 "move_files":[{"file":"<path>","from_stage":"<id|unassigned>"}]}
{"action":"remove_stage","stage_id":"…","move_to":"<id|null>"}
{"action":"merge_stages","stages_to_merge":["sid1","sid2"],"into":"<target id>"}
{"action":"split_stage","source_stage":"…",
 "new_stages":[{"id":"…","title":"…","description":"…","parent":"<usually source>","files":["p1","p2"]}]}
```
Output: one JSON block `{"changes":[…],"rationale":"<one paragraph>"}`; healthy+covered → empty changes.
`_PROPOSAL_SCHEMA_HINT` restates the envelope.

**Focused parallel prompts** (doctor_workers > 1; disjoint scopes):
- `_SPLIT_RULES` (per overloaded stage): ONLY `split_stage` on the named target; new ids `<source>.N`,
  no collisions; every moved file must currently be in the target (files listed with purposes);
  0 changes if actually coherent.
- `_GLOBAL_RULES`: ONLY `add_stage`/`merge_stages`/`remove_stage` (never split); priorities = unassigned
  coverage then starvation/dead cleanup; ≤3 changes.

**`_normalize_change_shape`** (LLM drift tolerance, add_stage only): reconstructs `new_stage` from
flattened/aliased top-level fields (`stage_id`/`name` aliases), maps `parent` literals
"top"/"none"/"null"/"" → null, coerces `move_files` bare-string paths into
`{"file", "from_stage": <current assignment or "unassigned">}` objects (stated from_stage kept, only
filled when absent; malformed entries dropped).

**`_validate_change(change, skeleton_doc, assign_result, protected_stages)`** → error string | None:
- add_stage: new id must not exist; move_files entries dict-shaped with non-empty file; from_stage must
  not be protected; `unassigned` sources must be in the unassigned set; stage sources must contain the file.
- remove_stage: id exists, not protected; move_to must exist and differ from stage_id; non-empty stage
  requires move_to.
- merge_stages: non-empty source list, all known, none protected; target not protected; target known or
  one of the sources.
- split_stage: source known; ≥1 new_stage; new non-source ids must not collide with existing or repeat;
  every listed file must be in the source bucket; at least one non-source new stage must move files.
- unknown action → error.

**`apply_change_files(skeleton_doc, change, assign_result) -> affected_files`** (pure dict edits,
in place):
- add_stage: append stage; affected = named move_files.
- remove_stage: affected = its bucket; pop stage; children re-parented to top level. (move_to is
  advisory — displaced files are **re-assigned** purpose-aware, not bulk-redirected.)
- merge_stages: affected = union of source buckets; drop merged-away stages; re-parent their children to
  the target.
- split_stage: affected = the whole source bucket + listed files; append new substages
  (parent defaults to source, crosscut false); a `new_stages` entry with id == source may re-describe it.
- Finish: re-run `synth_stages._normalize` on the stage list; preserve metadata
  (`drafted_by` kept, default `"synth_agent"`).

**Parallel critics** — `_run_critics_parallel(api, roles, task_context, proposal, hint, evidence,
prev_verdicts=None)`: one thread per role (pool size = len(roles)); each call wrapped in `_with_llm_cap`;
any failure (call error, parse failure, exception, missing slot) resolves to a conservative REJECT
verdict — always exactly len(roles) verdicts; vacuous REVISE normalized; round-2 context embeds the
same critic's round-1 verdict.

**`parallel_actor_critic(api, actor_prompt, *, task_context, hint, evidence, roles=_CRITIC_ROLES,
max_revise_rounds=1) -> proposal | None`**: mirrors `critic.actor_multi_critic_loop` exactly, but the
critic fan-out is parallel and every LLM call is semaphore-capped. All-APPROVE → v1; any REJECT with no
revise budget → None; else aggregate `[role] concern` list → revise → parallel round 2 → accept iff no
REJECT.

**`run_doctor_files(api, skeleton_doc, assign_result, *, purposes=None, max_revise_rounds=1,
doctor_workers=1, lang="en")`** — one doctor round:
- task_context = `"File-level skeleton doctor. N stages, M files, U unassigned."`;
  review_evidence = `_render_stats` (purposes threaded in for the unassigned render via `stats["_purposes"]`).
- `doctor_workers <= 1`: single global actor prompt → parallel_actor_critic → `_apply_changes` (validate
  each change against the mutating skeleton but the original bucket snapshot; count applied/rejected).
- `> 1`: fan out one `_split_task(sid)` per overloaded stage + one `_global_task` over a
  ThreadPoolExecutor(doctor_workers); collect proposals; apply **deterministically**: all split changes
  first, then global changes with `protected_stages = overloaded set` (a global merge/remove/pull
  touching a just-split stage is rejected by validation).
- Returns `{skeleton_changed: n_applied>0, affected_files, n_applied, n_proposed, n_rejected,
  summary: "DoctorFiles[serial]…" | "DoctorFiles[parallel xN: K split + 1 global]…"}`.

**`reassign_subset(api, graph, skeleton_doc, files_subset, prev_assign, *, purposes, batch_size=25,
max_workers=6)`**: re-runs `file_assign._assign_batch` for only the subset (batched, threaded), merged
over the previous file_stage map, then `_rebuild_assign`: every file re-bucketed against the **current**
valid stage ids; stale/now-invalid stages → unassigned; `also` filtered. Called even with an empty
subset to drop phantom buckets after structural deletes.

### 5.5 Phase 2c — `organize_stages.py` (intra-stage organization)

**Call-graph priors**:
- `file_call_adjacency(graph)` → `{file: set(files it calls into)}` from internal→internal edges
  (id→file map over internal nodes; self-edges dropped).
- `suggest_order(files, adj)` — Kahn's topological sort of the in-stage subgraph, callers before
  callees; ready queue and cycle leftovers sorted by tiebreak `(-out_degree, path)` (orchestrators first).

**Prompt `_RULES`** (EN; `_RULES_ZH` mirrors, Chinese titles/summaries): "You are organizing the files
of ONE stage of a system handbook into a readable structure." Given the stage's files (one-line purpose
each) in suggested execution order. Jobs: (1) group into **2–8 coherent SUB-GROUPS**; (2) order files
within each group as a narrative (entry/setup → core work → finalization) respecting suggested order
and `calls into` hints; (3) order the groups the same way. Rules: every file in EXACTLY ONE group,
exact paths, short noun-phrase titles, one-sentence summary. Output:
```json
{"groups":[{"title":"...","summary":"...","files":["<exact path>", ...]}]}
```
Stage prompt = rules + `## Stage: <id> — <title>` + description + `## Files in this stage (N, suggested
execution order)` with rows `- file  [role, N fn]\n    purpose  calls→ [up to 4 in-stage callees]`.

**`_organize_one_stage`**: 1 file → trivial single group, no LLM. Otherwise temperature-0 call;
LLM crash or empty groups → single flat `(ungrouped)` group in suggested order. Validation of LLM
groups: only known files, dedup across AND within groups (walked file-by-file), empty groups dropped,
default title "Group"; files the LLM didn't place → appended `{"title":"Other","summary":"(not placed
by the model)"}` group. `_finalize_stage` inlines per-file info
(`{file, purpose, role, n_functions}`) and computes flat `ordered_files`.

**`organize(api, graph, skeleton_doc, assign, file_purposes, *, workers=8, lang="en")`**:
works only non-empty buckets whose stage exists; ThreadPool with Progress; a per-stage exception falls
back (with `logger.exception`) to one flat group `(organize failed; flat call-graph order)` — a stage's
files are never dropped. Output re-keyed in skeleton order:

```yaml
metadata: {phase2_organize: true, n_stages: N}
stages:
  stage-1:
    title: "…"
    groups:
      - title: "…"
        summary: "…"
        files: [{file: "...", purpose: "...", role: "...", n_functions: 3}, …]
    ordered_files: ["path", …]      # flat order across groups
coverage: {n_files: <distinct files across buckets>, n_organized: <sum of ordered_files>}
```

---

## 6. Phase 3

### 6.1 `load_inputs.py`

`load_all(phase2_dir)` requires `cards/`, `skeleton.yaml`, `file_stage.json`,
`stage_organization.yaml` (FileNotFoundError listing missing). Builds:

`StageTree` dataclass:
- `stages_by_id`, `order` (skeleton/lifecycle order), `top_level` (parentless, order-preserving),
  `children_of` (re-derived from `parent` — robust to stale `children` lists),
  `buckets` (file_stage.json `buckets`), `organization` (stage_organization `stages`),
  `cards`, `metadata` (skeleton metadata).
- Methods: `title(sid)` (fallback sid), `description(sid)`, `is_crosscut(sid)`, `children(sid)`,
  `direct_files(sid)` (organization `ordered_files` when present else raw bucket),
  `groups(sid)`, `subtree_file_count(sid)` (recursive).

### 6.2 `rollup.py` — cached LLM summaries (substage / stage / system)

`_PROMPT_VERSION = "phase3-rollup-v3-plain"` — bumped whenever prompt wording changes to invalidate caches.

**Stage prompt** (`_STAGE_RULES_EN`/`_ZH`): "You are writing a system handbook for a large codebase,
aimed at a curious NON-EXPERT reader… you are writing the OVERVIEW for one stage." Given stage
title/description plus its SUB-STAGES (each with its own overview) and/or directly-owned SOURCE FILES
(one-line purposes). Write **100–200 words** plain-language overview (ZH: 100–200 字): what the stage
is for / where it fits (startup, main loop, shutdown, shared support) and how its parts cooperate
"like parts of a machine". Requirements: plain language, short sentences, explain terms on first use,
analogy welcome, concrete/accurate, no filler; output ONLY prose — no title/list/markdown/echo.
Assembled as: rules + `## Stage title:` + optional `## Stage description:` + optional
`## Sub-stages it contains (with their overviews)` (`### <child title>` + summary each) + optional
`## Source files assigned directly to this stage` (one-liner rows) + tail
"Now output this stage's overview in English:" / "现在用中文输出本阶段的概述：".

**System prompt** (`_SYSTEM_RULES_EN`/`_ZH`): top-level overview for the same non-expert reader,
**200–350 words** (ZH 200–350 字): what the system does/what kind of thing it is, start-to-finish story
threading the key stages, shared behind-the-scenes support. One clear story, plain language, ONLY prose.
Assembled: rules + `## System shape: <archetype>` + `## Top-level stages (in execution order, with
their overviews)` (`### title` + summary) + tail.

**Caching**: `cache_dir/rollup/<sid-sanitized>_<sha1(prompt-version + lang + kind + sid|archetype + full prompt)[:12]>.md`.
`refresh=False` → return cached if present. On LLM failure or empty text: warn + deterministic fallback
(stage: description or title; system: archetype or "(system overview generation failed.)");
fallback **is written to cache** too. Calls use temperature 0.0; result = `raw_text.strip()` (prose,
not JSON).

### 6.3 `registers.py` — state-register extraction (loop-until-dry) + rendering

`_PROMPT_VERSION = "phase3-registers-v3-plain"`.

**Round-1 prompt** (`_RULES_EN`/`_ZH`): "Identify this system's **state registers** — pieces of
global/shared state that flow ACROSS multiple stages and are read/written repeatedly." Example
categories (config stack/flags, auth/credentials, live session/thread history/rollout handles, tool
catalog/plugins/MCP/model catalog, sandbox/exec policy/env/proxy, UI state/server processor/telemetry/
job queues). Evidence given: all top-level stage overviews + data_model files (role=data_model) with
purposes. Requirements: stable id `reg-xxx` (lowercase-hyphen; ZH keeps ids English), one-line
plain-language semantics, `stages` = only real given stage ids; only genuinely cross-stage state;
count reflecting real scale ("a large agent runtime usually has 20–35"). Output:
```json
{"registers":[{"id":"reg-xxx","semantics":"one-line semantics","stages":["stage-5","stage-9"]}]}
```

**Gap prompt** (`_GAP_RULES_EN`/`_ZH`): completes the list — given already-identified registers, find
ONLY the missing ones; do not repeat/rename; focus on easily-overlooked ones (background jobs/queues,
caches, connection pools, rate limits, token budgets, goal/memory state, telemetry buffers,
update-check state); empty array if nothing is missing.

**`extract_registers(api, top_summaries, data_model_files, valid_stage_ids, *, cache_dir,
refresh=False, data_model_cap=120, max_rounds=5, dry_streak=2, lang="en")`**:
- Evidence block: `## Top-level stages (with overviews)` (`- sid · title：summary`) +
  `## data_model files (total N, excerpt)` (`- \`path\`：purpose`, capped at 120 with a
  "(another K … not listed)" note).
- Cache: `cache_dir/registers/registers_<sha1(version+lang+evidence+"r{max_rounds}s{dry_streak}")[:12]>.json`
  — the whole multi-round result cached as one unit.
- Round 1 = full rules; rounds 2..max_rounds = gap rules + evidence +
  `## Already-identified registers (do NOT repeat these)`; loop stops after `dry_streak` (2) consecutive
  rounds adding nothing, or max_rounds (5). Accumulate by unique id.
- `_normalize_registers`: dict shape, non-empty id+semantics, unique ids, `stages` filtered to valid ids.
- LLM failures per round → warn, `[]` for that round; total failure → `[]` (build never blocks).

**Rendering**:
- `render_register_table(registers, title_of, lang)` → `## 🔄 State Flow Overview` /
  `## 🔄 状态流动总览` + `| State register | Semantics | Stages touched |` table; stage cells are
  `[title](sid.md)` links; `|` in semantics escaped; empty → italic "(No state registers extracted.)".
- `render_stage_registers(sid, registers, lang)` → per-stage section under marker
  `## 📊 State Registers Touched` / `## 📊 本阶段涉及的状态` with `- \`reg-id\` — semantics` bullets;
  empty string if no hits. `stage_section_marker(lang)` exposes the marker for idempotency checks.

### 6.4 `render_file.py` — leaf rendering (NO LLM)

- `file_one_liner(rel, card)` → `` - `rel`  — purpose  [role] ``.
- `render_file_md(rel, card, lang)` → markdown starting at H3:
  ```
  ### `<rel>`

  `role` · `lifecycle`            # lifecycle badge only when set and != "none"

  <description | purpose | "_(This file has no description yet.)_">

  #### Function details           # zh: 函数细节 (only when functions present)

  ##### `qualname`  (lines a–b)   # zh: (行 a–b)

  ```
  <signature fenced>
  ```

  **Purpose**: …                  # each of purpose/data_flow/relations its own paragraph
  **Data flow**: …
  **Call relations**: …

  *Call graph*: calls N internal fn (leaf, names…, +K more); called by N (…); N external calls (…).
  ```
- Relation name lists capped at 10 (`_REL_NAMES_CAP`), rendered as leaf names
  (`split("::")[-1].split(".")[-1]`), with `(+K more)`. ZH labels: 作用/数据流/调用关系/调用图, `：`
  separators, `；` joiners, `。` terminator.

### 6.5 `build_handbook.py` — Phase 3 driver

`build(phase2_dir, out_dir, *, api=None, lang="zh"(lib default; CLIs pass en), workers=8,
refresh=False, subtree=None, html=False, html_single=False, agent=False, model=None, api_user=None,
api_key=None) -> stats`:

1. Construct Api (with optional model/api_key overrides) unless supplied. mkdir out_dir; cache =
   `out_dir/cache`.
2. `load_all`. Optional subtree restriction (`allowed` = subtree + descendants; ValueError for bad id).
3. **Content rule**: a stage gets a page/summary iff it has children or a non-empty bucket
   (`has_content`); empty placeholders skipped everywhere.
4. **Depth batching**: `_tree_depths` from real parent/child relations (root=0; unreachable stages
   default 0). Iterate depths **deepest first**; within a depth, ThreadPoolExecutor(workers) runs
   `summarize_stage` per stage: child_summaries = `[(child title, summary)]` for already-summarized
   children; file_lines = one-liners of `direct_files`. On failure: fallback = description or title.
   Each stage page is **written immediately** on completion:
   `out_dir/<sid>.md` = `_stage_page_md` (crash-safe; pairs with the content-hash cache).
5. **Stage page `_stage_page_md`**:
   ```
   # <Title>  `<sid>`[ (cross-cutting infrastructure)]

   <summary>

   ## Sub-stages                    # zh: 子阶段 (if children)
   - [Child Title](child-id.md) `child-id` — N files

   ## Files in this stage           # zh: 本阶段的文件 (if direct files)
   ### <Group title>                # when organization groups exist
   <group summary>
   <render_file_md per file>        # ungrouped defensive leftovers appended after groups
   ```
6. **System overview**: full mode — `summarize_system(archetype from skeleton metadata,
   [(title, summary)] over top_level)`; subtree mode — the subtree root's own summary; index roots =
   `[subtree]` or top_level. Title = `$HANDBOOK_TITLE` or `"System Handbook"`.
7. **Registers** (full mode only; subtree skips): `extract_registers(top-level (sid,title,summary),
   data_model cards (role=="data_model") as (path,purpose), valid ids = all stage ids)`.
8. Top-level pages:
   - `overview.md` = `# <title>` + `## 🗺️ System Overview`/`## 🗺️ 系统总览` + prose + `---` +
     `## See also`/`## 另见` with links to `register.md` (only when registers exist;
     "State-flow registers — global state that flows across stages") and `index.md`
     ("Stage Index — every stage and what it does").
   - `register.md` (only when registers) = `# <title> — State Flow`(/状态流动) + register table.
   - `index.md` = `# <title> — Stage Index` + intro ("Each stage below links to its full page; the
     paragraph is the stage's role in the system.") + recursive walk: heading level = depth+2 capped
     H6: `[Title](sid.md) \`sid\`[ · (cross-cutting)] — N files` followed by the full rollup summary.
9. **Stage-page register annotation** (idempotent): for every stage a register touches, if the page
   exists and does not already contain the marker, append `render_stage_registers` section.
10. Optional arms: `agent` → `render_agent.render_agent_site` (roots=subtree when set);
    `html` → `render_html.render_site`; `html_single` → `render_html.render_single_page`. All reuse
    in-memory tree/summaries/registers — zero extra LLM.
11. stats: `{n_stages_summarized, n_files, n_registers, out_dir, [n_agent_pages, agent_dir],
    [n_html_pages, html_dir], [single_page, single_page_bytes]}`.

### 6.6 `render_agent.py` — agent locator arm (deterministic, no LLM)

Writes `<out>/agent/{how_to_use.md, index.md, disambiguation.md, <sid>.md…}`. Fixed-schema locator
blocks; **data-gating invariant**: a field is emitted iff its structural signal exists (empty field is
information).

Structural derivations:
- `build_file_stage_index(tree)` — file → owning stage over ALL buckets.
- **Strong co-change** `strong_twins(rel)` — same-directory `<stem>_tests.rs` / `<stem>_test.rs` twin
  (path-scoped, never bare basename). Rendered ``- `src` ↔ `twin`  [twin-stage]``.
- **Weak co-change** — organization sub-groups folded to `- <group title> (N files)`.
- **Exemplar** `group_exemplar(group, cards)` — the file in a sub-group with the most functions
  (organization n_functions, falling back to card function count); None if nothing function-bearing.
- **Entry concepts** `entry_concepts(sid, cap=8)` — distinctive file stems of direct files
  (generic tokens dropped via `_GENERIC_TOKENS` — mod/lib/main/src/errors/tests/util/… plus title-level
  themes), deduped, organization order.
- **Core files** `core_files(sid, cap=6)` — direct files ranked by role priority
  (`entrypoint, orchestration, domain_logic, data_model, io, adapter, config, util, test`; unknown
  last) then function count desc.
- **Disambiguation** — title tokenization (`_title_tokens`: lowercase word split, drop generic +
  len≤2); `build_title_token_index` (token → stage ids); `build_collision_index`: keep tokens with
  document frequency in `[2, _MAX_COLLISION_DF=6]` (above = system-wide theme) that are NOT a pure
  ancestor chain; ordered by skeleton order; sorted rarest-first.
- **State** `stage_registers(sid, registers, tree)` — two tiers: DIRECT (extraction placed the register
  on this exact sid); SUNK (leaf stages only: register anchored on an ancestor whose id concept-words —
  `_register_words`, stopwords like reg/state/catalog/… dropped — intersect the leaf's concept
  vocabulary `_concept_subwords` = entry stems + title tokens split on `_`); sinks carry the matching
  `via` word; deduped (direct wins).

**`stage_locator_block(...)`** (heading level configurable; index links headings to `<sid>.md`):
`# sid · Title` then gated lines: `**Duty**:` (the summary's full **first paragraph**, newlines
flattened — deliberately not first-sentence-only), `**Entry concepts**:` backticked stems `/`-joined,
`**State**:` reg ids (sunk ones annotated `(inherited, via <word>)` / `（继承自父级，按概念词 …）`),
disambiguation back-link `**⚠️ Name collides — searching these words also lands elsewhere; see
[disambiguation.md](disambiguation.md)** (\`w1\`, \`w2\`)`, `**Exemplar** (copy this when adding a new
one):` bullets `- \`file\` [group] (N fns)`, `**⚠️ Strong co-change (change src → change its test)**:`,
`**Related (same sub-group — topical, verify before editing)**:`, `**Core files**:`
bullets `- \`file\`  \`role\` (N fns)`. Full ZH label set in `_UI` (职责/入口概念/状态/范本/强共变/相关/核心文件).

**`how_to_use_md(lang)`** — fixed operating-protocol page: what the handbook IS (locator index) /
IS NOT (replacement for code; every fact anchored; "Jump there and Read the real file — the handbook
can be stale; the code is the only source of truth."); lookup recipes (where to change X → Entry
concepts → Exemplar; what else changes → Strong co-change + Related; many hits → disambiguation.md;
state changes → State's reg-* → register.md); "An empty field is information"; trust boundary
(anchors deterministic → trust; prose → direction only).

**`disambiguation_md`** — organized BY WORD: `## \`word\`  (N hits)` + per-stage
`- [\`sid\`](sid.md) Title — <one-liner>` (layer-2 `notes[word][sid]` when provided, else duty line,
else title). `written` set: stages without an emitted page (subtree mode) rendered as plain
`` `sid` `` — never a dead link.

**`index_md`** — HOW-TO pointer + every content-bearing stage as a locator block, walked in skeleton
order, heading level = depth+2 capped 6, headings linked.

**`stage_page_md`** — locator block at H1, then `---` and every owned file's `render_file_md` card in
organization order.

**`render_agent_site(tree, summaries, registers, out_dir, *, lang, disambig_notes=None, roots=None)`**
→ `{n_stage_pages, n_collisions, agent_dir}`.

### 6.7 `render_html.py` — HTML site (NO LLM)

Optional deps degrade gracefully: `markdown` (extensions fenced_code+tables; fallback escaped `<p>`
split on blank lines) and `pygments` (RustLexer, inline no-class formatting for signatures; fallback
escaped text).

**Multi-page site** `render_site` → `<out>/html/`:
- `index.html` — meta-refresh redirect to overview.html.
- `overview.html` — H1 system overview (markdown), optional register link, `Stages` card grid of
  top-level stages (`_stage_card`: linked title, crosscut badge, `sid · N files` meta, first-sentence
  blurb capped 160 chars sentence-aware incl. `。`).
- `register.html` — Register/Semantics/Stages-touched table; stage cells link to stage pages.
- `<sid>.html` per content-bearing stage: H1 + crosscut badge, `sid · N files` line, rollup summary
  (markdown), Sub-stages card grid, Files section grouped by organization (group h3 + summary; files as
  collapsed `<details>`: summary = path + role/lifecycle badges; body = description/purpose (markdown),
  `Functions` header, each function a nested `<details class=fn>`: summary `code qualname` + `lines a–b`;
  body = highlighted signature `<pre>`, Purpose/Data flow/Call relations fields, italic call-facts line),
  and a `📊 State Registers Touched` list when registers hit the stage.
- **Shared shell** `_page`: sticky 300px sidebar TOC (Overview/Registers links + full stage tree,
  current page `class=cur`), top bar buttons `🌓 Theme` (persisted `localStorage['hb-theme']`,
  `data-theme=dark` on root), `Expand all` / `Collapse all` (`hbAll(open)` over `.main details`),
  breadcrumb (`System / parent / … / current`). All CSS/JS inlined; GitHub-ish light/dark palette via
  CSS variables; progressive disclosure via native `<details>`; relative links → works over `file://`.
- Full ZH chrome map `_HUI` (系统总览/阶段/子阶段/本阶段的文件/函数/…).

**Single page** `render_single_page` → `<out>/handbook.html`:
hierarchical section numbers (`_number_map`: 1, 1.1, 1.1.1 by tree position), anchor-based sidebar TOC,
overview + top-level cards, then every content-bearing stage as a **collapsed top-level `<details
id=sid>`** (summary = number + title + badge + `sid · N files`) containing summary prose, sub-stage
anchor cards, grouped file details, per-stage register list; registers table at the end
(`id=registers`, in-page anchors). Collapsing keeps a page holding ~34k functions renderable.
Returns `{n_stages, path, bytes}`.

---

## 7. `build_site.py` — post-hoc bilingual static site (NO LLM)

A separate, more designed static-site generator that consumes **two finished markdown handbooks**
(EN + ZH) and the actual source tree, producing `site/`:

```
site/
  index.html                bilingual landing (lang toggle zh/en; ?lang= param)
  assets/style.css app.js   (pre-existing assets, not generated here)
  assets/fnidx-{en,zh}.js   generated: window.FNIDX = {fnName: ["sid|path", …]}
  en/  zh/                  stage-*.html, register.html, fnindex.html, index.html(redirect)
  code/<rel-path>.html      one highlighted source page per documented file
```

Config: `ROOT` hardcoded (historical path); `SITE = $HANDBOOK_SITE_OUT || ROOT/site`;
`CODE_SRC = ROOT.parent/codex/codex-rs`; per-language sources `$HANDBOOK_SITE_EN_SRC ||
work/codex/handbook`, `$HANDBOOK_SITE_ZH_SRC || work/codex_zh/handbook` (relative values resolve
against ROOT). `LANGS` carries full bilingual label dictionaries (handbook title "Codex System
Handbook"/"Codex 系统手册", nav labels, filter placeholders, prev/next, function-index strings).

Pipeline (`main()`):
1. `collect_file_set()` — scan both languages' `stage-*.md` for `### \`path\`` headings; keep paths
   that exist under CODE_SRC → global `FILE_SET`.
2. `collect_macro_map()` — grep each source file for `macro_rules! name` → `MACRO_MAP["name!"] = [(path,line)]`.
3. `build_code_pages(force)` — for each FILE_SET path, one HTML page: topbar (brand, Back, language
   tag, theme button), file header (path + line count), `<pre>` where every line is
   `<i id="L<n>">…</i>`. Rust files get a hand-rolled single-pass line highlighter (`RUST_TOK` regex:
   block/line comments with cross-line block-comment state, strings, lifetimes, chars, attributes,
   `macro!` tokens, numbers, keywords from `RUST_KW`; token classes c/s/m/n/k). mtime-based skip unless
   `--force-code`.
4. `build_lang(lang)` for en+zh:
   - `parse_index(index.md)` → stage tree of `Node(depth,title,sid,badge,count,desc_lines,children)`
     via `HEAD_RE` matching `#{2,6} [Title](stage-N.md) \`stage-N\` … — N files|个文件`.
   - `collect_fn_map` — scan stage pages for `### \`path\`` + `##### \`fn\`` pairs →
     full/short name → `[(sid, anchor, path, name)]`; anchor = `slug(path)--slug(name)`.
   - `build_fn_index` — fnindex.html: disambiguation sections for every call-graph token documented in
     >1 place (`FN_TOKEN_RE` over `*Call graph*` lines), plus a client-side search over the generated
     `fnidx-<lang>.js` data.
   - Per stage page: breadcrumb, stage head (title + `sid` chip + file-count chip + ✕ crosscut badge),
     intro, sections split on `## `:
     - Sub-stages section → card grid parsed from `- [Title](stage-x.md) \`stage-x\` … — N files` rows.
     - `📊`-prefixed section → collapsed register list; `reg-*` ids link to `register.html#reg-…`.
     - Files section → per-file `<details class=file id=slug(path)>` with tag badges (parsed from the
       role/lifecycle backtick line), prose, and `Function details` block: per-function
       `<details class=fn id=anchor>` with line-range links into `../code/<path>.html#L<n>`; call-graph
       lines rewritten by `link_callgraph_line` — tokens resolve (in order) to: same-file anchor →
       unique cross-page match (else `fnindex.html#fn-<slug>`) → curated `EXTERNAL_DOC` map (std/tracing/
       anyhow/serde_json/tokio/clap/uuid/… macros & functions; genuinely ambiguous std names go to the
       std doc search page) → repo `MACRO_MAP` (unique) → plain text.
     - prev/next stage nav.
   - Register page: register.md table rendered with `id=<reg-id>` anchors on the first column.
   - Landing data: `rich()` — default-expanded `<details>` tree of all stages with descriptions;
     overview markdown re-rendered plus a **hardcoded bilingual ASCII lifecycle diagram + one-turn
     diagram + top-stage map** (`codex_ascii_overview`).
5. `build_landing` — one index.html with both language sections (`data-lang`, hidden), hero with
   stage/file counts + register/fnindex links, filter input, expand/collapse tools, language segment
   toggle, theme button.

Markdown renderer is custom (regex-based `render_inline`/`render_blocks`/`render_table`): escapes;
strips pictographic emoji; stashes/restores code spans and md links; auto-links bare `dir/file.ext`
paths in prose to code pages when in FILE_SET; `reg-*` code spans link to the register page; bold/italic;
fenced code; lists (with continuation lines); tables; hr; headings with optional shift. Placeholder md
links (non-URL, non-.md/.html) are deliberately rendered as plain text.

Page shell: Google-Fonts link (Source Serif 4 / Inter / IBM Plex Mono / Noto Serif+Sans SC), theme
bootstrap script (localStorage `hh-theme` + prefers-color-scheme), progress bar div, `assets/style.css`
+ `assets/app.js` (expected to pre-exist), inline SVG brand mark / icons, slide-in code pane iframe
(`CODEPANE`) with resize/close.

---

## 8. Concurrency model (summary)

| Pass | Pool | Size knob | Unit |
|---|---|---|---|
| 2a read_files | ThreadPoolExecutor | `--read-workers` (12) | one batch (`--read-batch-size`, 8; deep→1) |
| 2b file_assign / reassign_subset | ThreadPoolExecutor | `--assign-workers` (12) | one batch (`--assign-batch-size`, 25) |
| 2b doctor diagnosis | ThreadPoolExecutor | `--doctor-workers` (1) | one actor-critic task (per overloaded stage + 1 global) |
| 2b doctor critics | ThreadPoolExecutor per proposal | len(roles)=3 | one critic call |
| 2b doctor global LLM cap | BoundedSemaphore | `--doctor-llm-workers` (max(assign,doctor,3)) | every doctor api.call across both nested pools |
| 2c organize | ThreadPoolExecutor | `--organize-workers` (8) | one stage |
| 3 rollup | ThreadPoolExecutor per depth level | `--phase3-workers` (8) | one stage summary (post-order guaranteed by deepest-first depth batching) |
| 3 registers | serial loop-until-dry | max_rounds=5, dry_streak=2 | one extraction round |

Rate limiting: only the Api retry loop (linear backoff + jitter, 429/5xx retried; 4xx permanent fail
fast) plus the doctor semaphore. All disk writes for cards happen on the main thread.

---

## 9. Error handling & resumability (summary)

- **Phase 1**: pure/deterministic; per-function extraction KeyError skipped (python adapter).
- **Api**: 6 retries, permanent-4xx fail-fast, RuntimeError after exhaustion.
- **2a**: three-tier degradation (batch → single → function chunks); incremental per-file card writes;
  backfilled empty cards keep coverage honest; `--resume` re-processes only not-`_is_done` cards
  (brief cards re-done under deep); `_coverage.json` records misses; card write failures non-fatal.
- **2b oneshot**: unusable skeleton → hard RuntimeError. Dropped/invalid assignments → `unassigned`.
- **2b doctor**: proposal validation rejects malformed/conflicting changes (counted, logged with
  action+keys); LLM shape drift normalized for add_stage; broken critics → conservative REJECT;
  actor failure → no change that round; stuck detection (2 no-progress rounds) and max_rounds bound;
  residual files stay honestly unassigned; protected stages prevent parallel-scope collisions;
  `reassign_subset` reconciles buckets even with an empty subset (drops phantom buckets).
- **2c**: LLM failure or bad groups → flat ordered fallback group; per-stage exceptions → deterministic
  flat fallback (files never dropped); LLM-unplaced files → "Other" group; intra-group dupes deduped.
- **3**: rollup summaries content-hash cached under `handbook/cache/rollup/` (key = prompt version +
  lang + kind + id + full prompt; `--phase3-refresh`/`--refresh` bypasses); stage pages written the
  moment each summary lands (crash-safe rerun); LLM failure → deterministic fallback prose (cached);
  register extraction cached as one unit under `cache/registers/`, total failure → `[]`;
  register stage-page append is marker-idempotent; subtree mode = cheap partial build.
- **Work-dir contract**: each phase reads only its upstream artifacts; any phase can be re-run
  independently via `--phase`, and Phase 3 needs no graph in memory.

---

## 10. Prompt template catalogue (all LLM touchpoints)

| # | Template (module) | Mode | Purpose | Output |
|---|---|---|---|---|
| 1 | `read_files._RULES` / `_RULES_ZH` | 2a brief | 1-2 sentence plain-language purpose + role enum + lifecycle per batched file | JSON `{purposes:[{file,purpose,role,lifecycle}]}` |
| 2 | `read_files._RULES_DEEP` / `_RULES_DEEP_ZH` | 2a deep | Full-file handbook leaf content: purpose, 120-300-word description, per-function purpose/data_flow/relations keyed by qualname | JSON adds `description`, `functions[]` |
| 3 | `read_files._build_chunk_prompt` | 2a deep fallback | Same deep rules over one function-chunk of an oversized file | one `purposes` entry |
| 4 | `synth_stages._SYNTH_RULES` / `_ZH` | 2b draft (oneshot) | Ordered narrative-spine skeleton from dir rollup + entry points; 12–25 top stages; crosscuts after main flow | JSON `{metadata:{archetype},stages:[{id,title,description,parent,crosscut}]}` |
| 5 | `synth_agent._DRAFT_SYSTEM_PROMPT` / `_ZH` + tool YAMLs | 2b draft (agent) | NexAU agent system prompt: get_orientation → propose_skeleton once; shallow well-ordered first draft | tool call `propose_skeleton(stages, metadata)` |
| 6 | `file_assign._RULES` | 2b assign | One primary stage per file from the menu (+optional `also`, `unassigned` escape) | JSON `{assignments:[{file,stage,also}]}` |
| 7 | `skeleton_doctor_files._ACTOR_RULES` (+`_ZH_NOTE`) | 2b doctor, serial | ≤3 structural changes (add/remove/merge/split) prioritized: unassigned → overload → starvation → dead | JSON `{changes:[…],rationale}` |
| 8 | `skeleton_doctor_files._SPLIT_RULES` | 2b doctor, parallel | split_stage ONLY, one named overloaded stage, ids `<src>.N` | same envelope |
| 9 | `skeleton_doctor_files._GLOBAL_RULES` | 2b doctor, parallel | add/merge/remove ONLY (coverage + cleanup, never split) | same envelope |
| 10 | `critic.ROLE_PROMPTS[engineer\|architect\|reader\|editor]` + `_CRITIC_OUTPUT_RULES` | 2b doctor critics | Role-played review of a proposal against ground-truth evidence; lean APPROVE | JSON `{decision,concerns,suggested_revision,rationale}` |
| 11 | `critic.build_revise_prompt` | 2b doctor revise | Actor revision addressing aggregated `[role] concern` list | same schema as original proposal |
| 12 | `organize_stages._RULES` / `_ZH` | 2c | 2–8 ordered sub-groups per stage; every file exactly once; narrative order | JSON `{groups:[{title,summary,files}]}` |
| 13 | `rollup._STAGE_RULES_EN/_ZH` | 3 | 100–200-word non-expert stage overview from child overviews + file one-liners | plain prose only |
| 14 | `rollup._SYSTEM_RULES_EN/_ZH` | 3 | 200–350-word system overview from top-level stage overviews + archetype | plain prose only |
| 15 | `registers._RULES_EN/_ZH` | 3 round 1 | Extract cross-stage state registers (reg-xxx + semantics + touched stages) from top-level overviews + data_model files | JSON `{registers:[{id,semantics,stages}]}` |
| 16 | `registers._GAP_RULES_EN/_ZH` | 3 rounds 2+ | Only the MISSING registers given the already-found list (loop-until-dry) | same schema, new only |

Temperature: every JSON-producing call passes `{"temperature": 0.0}` (dropped automatically for
reasoning models). ZH variants always keep JSON keys, enum values, ids, action names, and file paths in
English; only prose values are Chinese.

---

## 11. Auxiliary scripts (non-pipeline)

- `_smoke_plain.py` — smoke test of the deep 2a reader on two small files
  (`SRC`/`SMOKE_GRAPH` env; prints model/endpoint and rendered card fields).
- `_inspect_card.py` — dump a sample card's shape from `work/**/phase2/cards/*.json`.
- `_agent_demo.py` — renders the agent arm on real data with **zero LLM** by recovering registers from
  a written `register.md` (table regex) and summaries from `index.md` (first paragraph per stage
  heading); default roots `["stage-14.2","stage-22"]` → `/tmp/agent_demo`.
- `_run_plain.sh` — regenerate EN+ZH plain-language handbooks into fresh work dirs:
  `run.py --phase 2a,3 --read-detail deep --read-batch-size 1 --read-workers 32 --resume
  --narrate-lang <en|zh> --phase3-workers 32 --phase3-refresh` per language.

## 12. Environment-variable inventory

| Var | Used by | Meaning |
|---|---|---|
| `OPENAI_API_KEY` / `HANDBOOK_LLM_API_KEY` | api_client | Bearer key (required; `EMPTY` for keyless local endpoints) |
| `OPENAI_MODEL` / `HANDBOOK_LLM_MODEL` | api_client | model (default gpt-4o-mini) |
| `OPENAI_BASE_URL` / `HANDBOOK_LLM_BASE_URL` | api_client | endpoint base (default api.openai.com/v1) |
| `OPENAI_MAX_TOKENS` / `HANDBOOK_LLM_MAX_TOKENS` | api_client | max tokens (16000) |
| `HANDBOOK_LLM_MAX_RETRIES` / `HANDBOOK_LLM_RETRY_BACKOFF` | api_client | retry policy (6 / 3.0s) |
| `LLM_MODEL` `LLM_BASE_URL` `LLM_API_KEY` `LLM_API_TYPE` `LLM_TEMPERATURE` `LLM_MAX_TOKENS` `LLM_EXTRA_BODY` `LLM_MAX_CONTEXT` | synth_agent (NexAU) | agent-draft endpoint |
| `NEXAU_TOOL_CALL_MODE` `SYNTH_AGENT_MAX_ITERS` | synth_agent | agent behavior |
| `HANDBOOK_TITLE` | build_handbook, render_agent | handbook title (default "System Handbook") |
| `HANDBOOK_SITE_OUT` `HANDBOOK_SITE_EN_SRC` `HANDBOOK_SITE_ZH_SRC` | build_site | site output / handbook sources |
| `SRC` `SMOKE_GRAPH` | _smoke_plain / _run_plain | smoke/regen inputs |

Third-party deps: `requests`, `pyyaml`, `tree-sitter` + `tree-sitter-language-pack` (or standalone
grammars) for non-Python adapters, optional `markdown` + `pygments` for HTML, optional `nexau` for
agent draft mode.

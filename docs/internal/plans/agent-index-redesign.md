# Redesigning `handbook/agent/` — design research

Status: research + proposal. Not a plan yet; no tasks, no checkboxes.
Scope: `packages/renderer/src/agent-site.ts` and what it emits into `<work>/handbook/agent/`.
Evidence base: the checked-in real output at `examples/work/self/handbook/agent/`, the
work dir it was rendered from (`examples/work/self/phase{1,2,3}/`), and prior art surveyed
2026-08-09.

Everything numeric below was measured against that work dir, not estimated. Where a number
comes from someone else's benchmark it is attributed and its weakness is stated.

---

## 0. The one-paragraph verdict

The agent artifact is the human artifact plus five extra lists. It is 2.1x the size of the
human index (33,497 B vs 15,959 B), 42% of it is model prose copied byte-for-byte from the
human pages, and it contains **zero symbol names** — while the model it renders from carries
1,059 symbols with exact line ranges, signatures, and 2,713 resolvable call edges. The
redesign is not mostly a writing problem. It is a problem of emitting data that is already
in `HandbookModel` and is currently being thrown away.

---

## 1. Verdict on each of the seven diagnoses

### 1.1 "Long model prose with metaphors; zero routing value, high token cost" — **RIGHT**, with one refinement

Measured on `agent/index.md` (33,497 B / 19,539 chars):

| line class | bytes | share |
|---|---:|---:|
| `**职责**` (duty paragraph) | 14,206 | **42.4%** |
| bullets (exemplar / related / core / co-change) | 11,566 | 34.5% |
| field labels | 2,502 | 7.5% |
| `**状态**` register ids | 1,547 | 4.6% |
| headings | 1,527 | 4.6% |
| `**入口概念**` | 1,196 | 3.6% |
| other | 953 | 2.8% |

The duty paragraph is `view.summary(sid)`'s first paragraph — the *same string* the human
`index.md` prints. The coffee-machine sentence appears verbatim in both files. This is not
prose written for an agent that happens to be flowery; it is prose written for a human,
re-emitted.

The refinement: "zero routing value" is slightly too strong. The **first sentence** does
route — `disambiguation.md` already uses exactly that, `truncate(firstSentence(...), 160)`.
It is the remaining 80% of the paragraph (the mechanism walk-through and the metaphor) that
has no routing value. So the fix is not "delete prose", it is "keep one sentence, delete the
paragraph". See §3.

### 1.2 "Counts but not names or line numbers" — **RIGHT**, and worse than stated

Probed ten real symbols against `agent/index.md`: `esc`, `renderHtmlSite`, `strongTwins`,
`buildCollisionIndex`, `resolveConfig`, `coerceRole`, `StageTree`, `parseArgs`, `loadModel`,
`scan`. **Zero** appear as symbols. (`esc` and `StageTree` each match once as a substring
inside the Chinese prose — `StageTree 类`, `esc` inside a word — which is worse than not
matching, because a grep for them returns a prose fragment.)

The counts are not merely less useful than names; the ranking they feed is wrong. `coreFiles()`
sorts by `ROLE_PRIORITY.indexOf(role)` **first** and function count only as a tiebreak, and
`data_model` (index 3) outranks `io_transport` (index 4). Result, verbatim from the output:

```
**核心文件**：
- `renderer/src/html-assets.ts` `data_model` (0 个函数)
- `renderer/src/html.ts` `io_transport` (25 个函数)
```

The "core file" of the HTML rendering stage is the one with no functions. Two stages show
this inversion (`rendering_html`, `rendering_markdown`). A model-assigned role label is
being used as a stronger ranking signal than a parser-measured count — which is backwards
under this repo's own trust boundary ("anchors are deterministic → trust them; prose gives
direction only").

### 1.3 "No symbol → location lookup; plausibly the highest-value missing thing" — **RIGHT**, and it is nearly free

Right on the absence, right on the value, and the important part you did not say: **the data
is already 100% present in `HandbookModel`.** `FunctionNote` carries `name`, `qualname`,
`className`, `lineRange`, `signature`, and the call-edge node ids. Nothing needs to be added
to the model to emit a symbol index for functions and methods.

Concrete cost of not having it. Asking "where is `renderHtmlSite` defined?" against the
current output:

```
$ grep -rn "renderHtmlSite" examples/work/self/handbook/agent/
… 29 hits. The definition (`##### \`renderHtmlSite\` （行 599–696）`) is hit #25.
```

Twenty-four references rank above the definition, because every caller's prose line mentions
it and there is one definition line. Against a sorted TSV built from the same model:

```
$ grep -m1 "^renderHtmlSite	" symbols.tsv
renderHtmlSite	renderer/src/html.ts:599-696	fn	rendering_html	0	function renderHtmlSite( model: HandbookModel, outDir: string, options: RenderOptions = {}, ): { nPages: number }
```

One hit, first hit, and the next action (`Read renderer/src/html.ts` lines 599–696) is on the
line. This is the single highest-leverage change in the whole redesign.

### 1.4 "Same files listed three times under 范本 / 相关 / 核心文件 with heavy overlap" — **PARTLY WRONG**, and the truth is worse

Two different defects, not one:

- **范本 (Exemplar) vs 核心文件 (Core files): real duplication.** 43 exemplar entries, 70
  core-file entries, **37 files appear in both** — 86% of the exemplar list is a subset of
  the core list. You are right about this pair.
- **相关 (Related): not a third copy — it names no files at all.** The code is
  `groups.map((g) => \`- ${g.title} (${L.files(g.files.length)})\`)`. It emits a group
  *title* and a *count*:

  ```
  **相关（同一子组 — 主题相关，编辑前请核实）**：
  - 配置注册表与类型定义 (6 个文件)
  ```

  50 such lines across `index.md`. Zero paths, zero symbols, zero ids. An agent cannot act on
  "配置注册表与类型定义 (6 files)" — it cannot grep it, glob it, or read it. This is not
  redundant data, it is 50 lines of unactionable data, which is a different and worse failure.

### 1.5 "入口概念 lists bare module basenames, not paths or symbols" — **RIGHT**, plus a bug

Right, and quantified: 70 entry-concept tokens across the index, and **35 of the 70 distinct
stems match more than one file in this repo** (`adapter`, `cards`, `coerce`, `file`, `graph`,
`html`, `doctor`, `generate`, …). Half of them are ambiguous the moment they are used.

Additionally, `fileStem()` strips only the final extension, so a TypeScript test file
`registry.test.ts` yields the stem `registry.test`. The `GENERIC_TOKENS` set contains `test`
but never sees it. Ten of the seventy entry-concept tokens are test-file stems:

```
`coerce.test` `concurrency.test` `ir.test` `model.test` `names.test`
`registry.test` `render-refresh.test` `server.test` `skill.test` `ui-drift.test`
```

`core_data_model`'s entry concepts are literally ``ir.test / ir / model.test`` — two of the
three "entry concepts" of the data-model stage are test files, and `model` itself is filtered
out by `GENERIC_TOKENS`. The stage whose whole subject is `model.ts` does not name `model.ts`.

### 1.6 "A 313 KB stage page will never be read whole; it will be grepped, and the format is not optimized for grep" — **RIGHT**, and the conclusion should be stronger

`analyzer_adapters.md` is 313,356 B / 199,343 chars / 7,999 lines / 559 function blocks. In
Chinese that is on the order of 150k–200k tokens: not "expensive to read whole", but
larger than the practical working budget of most sessions.

Composition:

| content | chars | share |
|---|---:|---:|
| signatures + file descriptions | 55,319 | 27.8% |
| call-graph fact lines (`*调用图*`) | 40,259 | 20.2% |
| `**调用关系**` prose | 31,591 | 15.8% |
| `**数据流**` prose | 26,702 | 13.4% |
| function headings (`##### name （行 a–b）`) | 19,930 | 10.0% |
| `**作用**` prose | 16,199 | 8.1% |
| fences / blanks / file headings | 9,344 | 4.7% |

Model prose is 37.3% of it. And grepping it is genuinely bad:

| query | hits | chars returned |
|---|---:|---:|
| `scan` | 576 | 56,899 |
| `adapter` | 58 | 4,699 |
| `grammarFor` | 27 | 1,226 |
| `discoverFilter` | 15 | 882 |

`grep scan` returns 56.9 KB. This repo's own planner (`packages/planner/src/tools.ts`) caps
grep at `MAX_GREP_HITS = 100` and truncates each line to 200 chars — so the agent gets ~20 KB
of prose fragments and the cap silently hides the rest.

Where I would push further than you did: the fix is not primarily "make the stage page
greppable". It is that **a per-symbol index should not be sharded by stage at all.** Stage is
one attribute of a symbol; sharding by it means an agent that does not yet know the stage
(the common case — that is *why* it is searching) must grep 22 files. One repo-wide sorted
index, plus a small stage page that routes, is strictly better. The 313 KB page should not
exist in any size.

Second: the facts on that page are spread across lines that do not co-occur. The name and
line range are on the `#####` heading, the signature is inside a fence two lines down, the
call edges are on a `*调用图*` line six lines down. **No single grep hit ever returns a
complete fact.** That is the format failure, more than the size.

### 1.7 "Human and agent artifacts render the same prose; that is the root mistake" — **RIGHT**, literally so in the code

`agentStagePageMd()` calls `renderFileCardMd()` — the same function `markdown.ts` calls for
the human handbook. The agent stage page *is* the human file card, prefixed by a locator
block. And the locator block's duty line is `view.summary(sid)`, the human stage summary.

The clearest proof that this is the root cause and not a symptom: **the agent index is 2.1x
the human index** (33,497 B vs 15,959 B). An artifact built for a consumer with a tighter
budget and a narrower question came out twice as large as the one built for a human who will
read it in a browser. That only happens when the agent artifact is defined as "the human one
plus extras" rather than as its own thing.

I agree it is the root mistake. Three corollaries you did not mention are in §2.

---

## 2. Findings the diagnosis missed

**2.1 The skill package does not ship the agent index or the agent stage pages at all.**
`packages/skill/src/build.ts` copies `references/index.md` and `references/stages/*.md` from
the **human** handbook, and from the agent site copies exactly
`AGENT_LOCATOR_PAGES = ['how_to_use.md', 'disambiguation.md']`. Verified against the built
demo skill at `examples/work/demo/skill/`: `references/agent/` contains those two files and
nothing else. The SKILL.md routing protocol tells the agent to route through
`references/index.md` — the human page. So the 715 KB of agent-site output is, in the
primary delivery channel, dead weight that never ships. Whatever is designed here has to be
wired into `buildSkill` or it will not reach a consumer.

**2.2 The model resolves call edges to exact locations; the renderer throws that away.**
`FunctionNote.calls` / `calledBy` hold node ids like `pipeline.src.cards.rulesFor`.
Measured across the whole work dir: **2,713 of 2,714 edge endpoints (99.96%) resolve to
`(file, line)` using nothing but the cards already in `HandbookModel`.** The one that does
not is `studio.src.jobs.JobRunner.constructor`, a synthetic node.

`callFactsLine()` renders those ids through `leafName()`, collapsing them to bare leaf names.
**12% of leaf names in this repo are ambiguous** (95 of 786): `constructor` ×28, `scan` ×13,
`grammarFor` ×13, `extractCalls` ×13, `moduleIdForFile` ×13. So the current output's
"*调用图*：调用 1 个内部函数 (scan)" is both unjumpable and, one time in eight,
under-determined. The fix costs one map build, not a model change.

**2.3 `lifecycle` is not a badge.** The schema comment says *"Short lifecycle hint: 'startup',
'main loop', 'cross-cutting', 'none', …"*. The model fills it with sentences. Real value for
`analyzer/src/adapters/cpp.ts`: *"在代码分析流程中，由适配器框架加载并实例化；首先调用
discoverFilter 过滤文件，随后用 grammarFor 解析文件并调用 scan 遍历语法树；…"* — 100+
characters, three clauses. Anything that puts `lifecycle` in a fixed-width column will
produce a 200-char row. Either constrain it in the prompt or do not emit it as a field.

**2.4 The example output is already stale by 167 lines, and nothing says so.**
`agent-site.ts`'s `agentIndexMd` is at line 619 in `src/` today; the checked-in cards place it
at 452–462. Line numbers are the most perishable fact the handbook can emit. The current
output emits them (on stage pages) with no freshness anchor of any kind — no commit sha, no
timestamp, no content hash. `references/coverage.json` in the skill has hashes; the agent site
has nothing. A redesign that makes line numbers the *primary* payload must ship a freshness
anchor with them.

**2.5 Deleting the prose deletes most of the i18n surface.** `agent-site.ts` is 677 lines, of
which lines 107–290 (27%) are an eight-language `LABELS` table, plus lines 515–580 are two
hand-written full-page translations of `how_to_use.md` (zh and en; the other six languages
silently fall through to English). Paths, symbol names, line numbers, roles and register ids
are language-neutral. A fact-dense format needs a handful of English column names, not a
translated label per field. This is a large simplification, not a cost.

**2.6 `disambiguation.md` costs more than it returns.** On this repo it contains exactly one
entry (`studio`, 2 hits, 435 B) — yet it gets its own file, a numbered step in `how_to_use.md`,
and a numbered step in every SKILL.md in eight languages. Meanwhile the genuine ambiguity in
this codebase is at the symbol level (`scan` ×13), which it does not cover at all, because it
only indexes **stage title tokens**.

**2.7 `llms-full.txt` is a convention this project adopted that the spec never defined.**
`renderLlmsTxt` emits `llms.txt` and `llms-full.txt`. Per llmstxt.org the second name is not
in the spec; the spec's tooling produces `llms-ctx.txt` / `llms-ctx-full.txt`, and
`llms-full.txt` is a community convention meaning "the whole corpus flattened" — the *inverse*
of the llms.txt thesis. In the one controlled benchmark on the question (§3.2) the inlined-full
condition matched the linked-index condition on accuracy and *cost more tokens*. Out of scope
for this document, but it is the same mistake in a different file: pay the corpus cost up
front instead of routing.

---

## 3. Prior art: what to steal, and from whom

### 3.1 aider's repo map — the closest prior art, and the most instructive failure

Sources: [`aider/repomap.py`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) ·
<https://aider.chat/docs/repomap.html> · <https://aider.chat/2023/10/22/repomap.html> ·
[`grep_ast.TreeContext`](https://github.com/Aider-AI/grep-ast/blob/main/grep_ast/grep_ast.py).

**Extraction.** The unit is
`Tag = namedtuple("Tag", "rel_fname fname line name kind")` with `kind ∈ {"def", "ref"}`, from
per-language tree-sitter queries. The *entire* Python semantic model is four patterns:
module-level assignments → constant defs, `class_definition` → class def, `function_definition`
→ function def, and `(call function: …)` → reference. **Only call sites are references.**
Imports, type annotations, inheritance clauses and decorators contribute nothing. Of ~228
languages listed, only ~70 have repo-map support.

**Ranking.** Nodes are **files, not symbols**; edges are `referencer_file → definer_file`, one
per identifier, and an identifier only produces an edge if it is both defined *and* referenced
inside the scanned repo. Weights are hand-tuned heuristics:

```python
if ident in mentioned_idents:                         mul *= 10
if (is_snake or is_kebab or is_camel) and len(ident) >= 8:  mul *= 10
if ident.startswith("_"):                             mul *= 0.1
if len(defines[ident]) > 5:                           mul *= 0.1
if referencer in chat_rel_fnames:                     use_mul *= 50
num_refs = math.sqrt(num_refs)
```

Then `nx.pagerank(G, weight="weight", personalization=…, dangling=…)`, with the personalization
vector seeded from files in the chat and from words in **the user's current message**
(`get_ident_mentions` is literally `set(re.split(r"\W+", text))`). Per-symbol ranks are
*derived*, not computed: each file's rank is split across its out-edges in proportion to weight.

**Budget.** `--map-tokens` defaults to 1024, scaled per model to
`clamp(max_input_tokens / 8, 1024, 4096)`. `map_mul_no_files` widens it when no files are in
the chat (CLI default 2; the constructor says 8 — a real discrepancy). Fitting is a **binary
search over tag count**, seeded at `max_map_tokens // 25`, that accepts a **±15% error band
including going over budget**, against a `token_count()` that *estimates* by sampling every
Nth line for any string ≥200 chars.

**What it includes and excludes** — verified against the code, not the marketing:

| element | in map? |
|---|---|
| signatures | yes |
| line numbers | **no** — `TreeContext(..., line_number=False, ...)` |
| **call edges / the graph** | **no — discarded entirely.** The graph exists only to rank |
| references | no; only `definitions[(fname, ident)]` are rendered |
| files already in the chat | no |
| third-party / dependency symbols | no |
| function bodies | *mostly* no — but see below |
| long lines | truncated to 100 chars |

Output format, verbatim from aider's own golden fixture
[`tests/fixtures/sample-code-base-repo-map.txt`](https://github.com/Aider-AI/aider/blob/main/tests/fixtures/sample-code-base-repo-map.txt):

```
tests/fixtures/sample-code-base/sample.py:
│class Car:
│    def __init__(self, make, model, year):
│        self.make = make
│        self.model = model
│        self.year = year
⋮
│    def accelerate(self, increment):
⋮
│    def honk(self):
⋮
```

Verbatim source lines prefixed `│`, elision marked `⋮`, files listed **alphabetically** — rank
determines membership only, never order.

#### What to steal

1. **The map is a routing table, not a knowledge base.** Stated in aider's own benefit list —
   *"If it needs to see more code, the LLM can use the map to figure out which files it needs
   to look at"* — and enforced by its prompt prefix: *"treat them as \*read-only\*. If you need
   to edit any of these files, ask me to \*add them to the chat\* first."* The success criterion
   is **whether the model asks for the right file next**, not whether it understood anything.
   That is the right evaluation target for §4.1, and it is not how the current `agent/index.md`
   is written.
2. **Membership by importance, not exhaustive listing.** *"It only includes the most important
   identifiers, the ones which are most often referenced by other portions of the code."* Our
   index today lists everything with no importance signal except a role sort that inverts
   (§1.2). We have `nCalledBy` for free.
3. **A budget is a contract.** Aider's is not, and it shows: [#752](https://github.com/Aider-AI/aider/issues/752)
   reports `--map-tokens 1024` producing a **16,419-token** map, confirmed against Anthropic
   console billing. Ours must be counted exactly and truncated deterministically — this repo
   already byte-compares generated files in CI, so "roughly 4 KB" is not a budget we can ship.

#### What to reject, and why we diverge

1. **Verbatim source lines.** "Signatures only, no bodies" is aspirational: the renderer is a
   *line-selection* heuristic, `header_max` is left at its default of 10 (the `30` override is
   commented out in the source), so **any definition ≤10 lines renders in full** — the fixture
   above shows entire JS function bodies. Aider's own FAQ documents the consequence: *"weaker
   models get easily overwhelmed and confused by the content of the repo map. **They sometimes
   mistakenly try to edit the code in the repo map.**"* `use_repo_map` is therefore **off by
   default for many models** — the project shipping its own counter-evidence. A format that
   does not look like source code does not have this failure mode. This is also a direct
   argument against the ctags-style search-pattern idea in §7.1: an emitted line of real source
   is an invitation to edit it in place.
2. **Discarding the graph.** Aider computes a full call graph and emits *none* of it — rank
   collapses to membership, and `to_tree` then sorts alphabetically, so even the ordering is
   lost. It does this because its output is source excerpts, where an edge has nowhere to live.
   Our output is line-oriented facts, where an edge is one line. We have 2,713 resolved
   endpoints (§2.2); emitting them is the cheapest large win available (§4.4).
3. **Omitting line numbers.** Deliberate in aider (`line_number=False`) because its output is a
   contiguous excerpt you read in place. For us line numbers are the *payload*, because the
   consumer's next action is a ranged `Read`. Stating the divergence matters: we are not
   forgetting to copy aider, we are optimizing a different next action.
4. **PageRank.** Aider's weights are heuristics, and two of them misfire in ways visible from
   the source: `len(defines[ident]) > 5 → ×0.1` penalizes exactly the interface names
   implemented across many files, and `ident.startswith("_") → ×0.1` erases private-but-central
   internals. The reported symptom on a mixed Java/Kotlin repo ([HN 43100150](https://news.ycombinator.com/item?id=43100150)):
   *"Aider's repo maps in this project are full of random useless stuff. Maybe it works better
   for Python."* We hold the **resolved** call graph, so in-degree (`nCalledBy`) is a parser
   fact, while a PageRank score is a derived opinion. Under invariants 1 and 2, emit the fact
   and let the consumer sort; do not emit a rank we cannot defend.
5. **Query-dependent output — unavailable to us by construction.** Aider's central mechanism is
   a *personalized* PageRank seeded from the user's current message. A rendered artifact has no
   query. So the single most sophisticated idea in aider's design is one this project
   structurally cannot use, and pretending otherwise would be the wrong lesson to take.

#### Two operational warnings

- **Non-determinism is a first-class cost.** [#1874](https://github.com/Aider-AI/aider/issues/1874):
  *"repomap generation appears to be non-deterministic because it changes between subsequent
  invocations even when nothing has changed"* — the map sits in the cached prompt prefix, so
  churn busts the provider-side cache. Cause is visible in the code: the ±15% early break plus
  sampled token estimation makes the binary search tie-break sensitive. For us this is not a
  new requirement, it is an existing one: `docs-drift.test.ts` byte-compares generated files.
  Any ranking or capping introduced in §4 must be a pure function of `HandbookModel`.
- **Cost at scale is real.** [#1587](https://github.com/Aider-AI/aider/issues/1587): a 165,715-file
  repo stuck at 100% CPU, 18% done after 4m41s. [#506](https://github.com/paul-gauthier/aider/issues/506):
  11k files, *"a full 1 or 2 minutes"*. Aider needs a `diskcache` SQLite tag cache keyed by
  mtime to make this tolerable, and hard-bails with *"Disabling repo map, git repo too large?"*
  on `RecursionError`. We pay none of this — our extraction already happened in phase 1 and the
  renderer is a pure function of an in-memory model. **That is the strongest structural
  advantage this project has over aider's design, and §4 should not spend it.**

### 3.2 llms.txt — steal the shape of the entry file, and steal "advertise the index in-band"

Spec: <https://llmstxt.org/> (Jeremy Howard / Answer.AI, Sept 2024). Repo:
<https://github.com/AnswerDotAI/llms-txt>.

Prescribed structure: H1 (the only required element) → blockquote summary → free-form
sections → H2 file lists, each entry `[name](url)` optionally followed by `:` and notes. A
reserved `## Optional` section marks links that *"can be skipped if a shorter context is
needed"* — the only budget control in the format, and it is a **declared priority tier**,
not a size limit.

Stated rationale, verbatim: *"context windows are too small to handle most websites in their
entirety."* The spec explicitly contrasts itself with `sitemap.xml`, which *"lacks
LLM-readable versions and may exceed context windows"* — exhaustive vs curated is the whole
distinction.

**What to steal #1 — the two-hop model.** Index is links plus one-line descriptions; bodies
are fetched only on demand. That is what §4 below builds.

**What to steal #2, and it is the more important one — advertise the index from every
artifact.** The evidence on passive discovery is bad and the evidence on active advertisement
is good, and they are different regimes:

- Passive: a ~900-domain server-log study (2025-09 → 2026-04, 1,227 requests to `/llms.txt`)
  found **zero requests from GPTBot, ClaudeBot, PerplexityBot or Google-Extended** —
  *"among the requesters there was not a single real AI bot."* SE Ranking's ~300k-domain study
  found 10.13% adoption, *falling* to 8.27% among high-traffic sites, and that removing
  llms.txt from their citation model **improved** test accuracy. Google is on record as not
  supporting it (Gary Illyes, Search Central Live; John Mueller: *"comparable to the keywords
  meta tag"*).
- Active: Mintlify's benchmark — 4 conditions × 20 docs sites × 5 questions × 3 reps =
  **2,400 runs**, driven by Claude Code and Codex. 404s per task: raw HTML 2.23 → plain
  markdown 1.42 → **markdown + a link to llms.txt 0.11**. Replicated across Opus 4.8
  (2.11→0.08), Fable 5 (1.13→0.00), GPT-5.6 (6.79→0.02). *"Linking won. Inlining the whole
  file into every page killed the same 404s but cost more tokens."*
  **Caveat: vendor benchmark, hosted docs, not a git repo.** It is the only controlled study
  of the mechanism I found, and it should be cited with that caveat attached.
- Existence proof: `https://code.claude.com/docs/llms.txt` is live and spec-shaped, and every
  page on that site prepends *"Fetch the complete documentation index at: …/llms.txt — Use
  this file to discover all available pages before exploring further."*

Applied here: an index nobody is told about is an index nobody reads. Today `SKILL.md` points
at the **human** `references/index.md` (§2.1). Whatever §4 produces must be named in
`SKILL.md`, in `how_to_use`, and in the head of every other file in the directory.

### 3.3 CLAUDE.md guidance — steal the exclude list; it indicts the current design directly

<https://code.claude.com/docs/en/memory>, <https://code.claude.com/docs/en/best-practices>.

Hard numbers: *"target under 200 lines per CLAUDE.md file. Longer files consume more context
and reduce adherence."* And the editorial test: *"For each line, ask: 'Would removing this
cause Claude to make mistakes?' If not, cut it. Bloated CLAUDE.md files cause Claude to
ignore your actual instructions!"*

The published include/exclude table is the most directly relevant prior art in this whole
survey. On the **exclude** side: *"Anything Claude can figure out by reading code"*,
*"Detailed API documentation (link to docs instead)"*, *"Long explanations or tutorials"*,
and — verbatim — ***"File-by-file descriptions of the codebase."*** Claude Code's `/doctor`
ships a linter whose stated behaviour is to cut *"directory layouts, dependency lists, and
architecture overviews"* and keep *"pitfalls, rationale, and conventions that differ from tool
defaults."*

Note precisely what this does and does not say. It does **not** say "do not generate a
per-file description of a codebase" — that is this product. It says such content must not
live in the always-loaded file. That is a statement about *tiering*, and it is exactly the
line the current `agent/index.md` crosses: it is the entry file and it is a file-by-file
description.

One correction worth recording, because it circulates wrongly: the 200-line/25 KB hard
truncation applies only to auto-memory `MEMORY.md`. *"CLAUDE.md files are loaded in full
regardless of length, though shorter files produce better adherence."* 200 lines is a target.

Also: *"Splitting into `@path` imports helps organization but doesn't reduce context, since
imported files load at launch."* A second hop only saves budget if it is a **tool call**, not
an import. Our second hop is `Read`/`grep`, so it does save.

By contrast, <https://agents.md/> prescribes **no size guidance at all** — its only scoping
mechanism is spatial (nearest file in the tree wins). Do not cite AGENTS.md for brevity; it
does not say that.

### 3.4 Cursor rules — steal conditional loading keyed to artifacts

<https://cursor.com/docs/context/rules>. Frontmatter is three fields — `alwaysApply`, `globs`,
`description` — and the four rule types are derived from their combination: Always Apply /
Apply to Specific Files (`globs`) / Apply Intelligently (`description`) / Apply Manually.

Verified size guidance: **"Keep rules under 500 lines"**, immediately followed by *"Split
large rules into multiple, composable rules"* and — the same principle as llms.txt, restated
for a local filesystem — ***"Reference files instead of copying their contents."***

Claude Code's `paths:` frontmatter is the direct analogue, and the docs add two operational
facts that matter here: path-scoped rules *"trigger when Claude reads files matching the
pattern, not on every tool use"*, and conditionally-loaded content **does not survive
`/compact`** while project-root CLAUDE.md does.

**What to steal:** the stage → path-prefix mapping in §4.1 is the glob. It is the one thing
that lets a host wire `stages/<sid>.md` to `paths: analyzer/src/adapters/**` and pay for it
only when the agent touches an adapter. The current output cannot support this, because
`入口概念` emits basenames instead of paths.

### 3.5 ctags — steal the file format wholesale

<https://docs.ctags.io/en/latest/man/tags.5.html>. Layout:

```
{tagname}<Tab>{tagfile}<Tab>{tagaddress}[;"<Tab>{tagfield}..]
```

Real lines produced by running universal-ctags 6.2.1 over this repo (7,152 TS symbols):

```
HandbookModel	packages/core/src/model.ts	/^export interface HandbookModel {$/;"	kind:interface	line:250	language:TypeScript
HandbookModel.cards	packages/core/src/model.ts	/^  cards: Record<string, FileCard>;$/;"	kind:property	line:254	interface:HandbookModel	access:public
```

Five ideas worth taking, in order of value:

1. **One fact per line, tab-separated, sorted.** Tabs are near-illegal in identifiers and rare
   in paths, so the delimiter never collides with the payload — no quoting, no escaping, no
   parser. Sorted so binary search (and `grep '^name\t'`) works. The spec is explicit: *"The
   tags file is sorted on {tagname}. This allows for a binary search in the file."*
2. **The `;"` extension marker.** Everything after it looks like a comment to a 1979 `vi`.
   Extension fields were bolted on decades later without breaking a byte of existing tooling.
   Format evolution by appending to the right of a comment marker is the best idea in the
   format and the least imitated.
3. **Self-labeling fields** (`kind:interface`, not bare `i`). Costs a few bytes; makes a
   truncated middle slice interpretable with no header in context. This is why ctags added
   `--fields=+z`.
4. **A self-describing header.** `!_TAG_FILE_FORMAT`, `!_TAG_FILE_SORTED`,
   `!_TAG_KIND_DESCRIPTION!TypeScript	f,function	/functions/`. The `!` sorts first in C
   collation, so the metadata free-rides on the sort order instead of needing a container.
5. **Qualified names as *additional* rows** (`--extras=+q` emits both `cards` and
   `HandbookModel.cards`). Duplicate rows are cheap; a missed lookup is not.

And one idea to take **with a caveat**: ctags's address is a *search pattern*
(`/^export interface HandbookModel {$/`), not a line number, precisely because line numbers
go stale. `--excmd=combine` emits both. We cannot copy this directly — see the open question
in §7.1.

### 3.6 SCIP — steal the symbol-string grammar, not the container

<https://github.com/sourcegraph/scip>, <https://sourcegraph.com/blog/announcing-scip>.

The grammar, from `scip.proto`:

```
<symbol>      ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
<namespace>   ::= <name> '/'
<type>        ::= <name> '#'
<term>        ::= <name> '.'
<method>      ::= <name> '(' (<method-disambiguator>)? ').'
```

A real symbol: `scip-python python PyYAML 6.0 yaml/dump().`

**The idea: the suffix character encodes the kind.** One string is simultaneously a unique
id, a human-readable path, a kind declaration, and a prefix-searchable key (everything under
`yaml/` shares a prefix). No separate `kind:` column needed.

Why SCIP beat LSIF, verbatim from the announcement: *"Slow development velocity caused by the
lack of static types"*, *"Difficulty of manually debugging raw LSIF payloads caused by the
heavy usage of opaque ID numbers"*, *"Complexity of implementing incremental indexing"*.
Measured: *"LSIF indexes are on average 4x larger when gzip compressed compared to SCIP"*;
*"10x speedup in our CI when replacing lsif-node with scip-typescript."*

And the line that maps onto this repo's invariant 2 almost word for word: Sourcegraph
describes SCIP as *"more robust against indexer bugs"* than LSIF **because human-readable
symbols make a wrong edge visible on inspection, where an opaque numeric id does not.** A
guessed edge being indistinguishable from a real one is exactly what `dropped-calls.json`
exists to prevent. Naming things in the emitted format is a correctness property, not an
ergonomic one.

Do **not** steal protobuf. SCIP chose it for I/O overhead and codegen; when the consumer is a
language model with `grep` and `read`, a binary container is a pure loss.

### 3.7 LSIF — the anti-pattern, and it is instructive

<https://microsoft.github.io/language-server-protocol/specifications/lsif/0.6.0/specification/>.
JSON-lines encoding a graph:

```
{ id: 22, type: "vertex", label: "definitionResult" }
{ id: 23, type: "edge", label: "textDocument/definition", outV: 6, inV: 22 }
{ id: 24, type: "edge", label: "item", outV: 22, inVs: [9], shard: 4 }
```

**No single line is independently meaningful.** Line 23 says "6 defines-to 22"; you cannot
know what 6 or 22 are without having read and retained the whole file. LSIF was explicitly
designed for streaming — but only on the producer side; the consumer must materialize the
graph. For a consumer that will see a truncated slice, it degrades to zero information.

This is the property to design *against*, and the current `analyzer_adapters.md` fails it for
the same reason: the name is on one line and the signature is on another, so a slice of the
middle is uninterpretable.

### 3.8 Search index vs navigation index — the distinction that sizes the artifact

GitHub's Blackbird (<https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/>):
115 TB corpus → 28 TB deduped → **25 TB index**. Ngrams, not just trigrams, because *"for
common grams like `for` trigrams aren't selective enough."* A search index is roughly the
size of the corpus, because it must find any substring.

Sourcegraph precomputes exactly four things for navigation: **definitions, references,
implementations, hover documentation**.

The conclusion that sizes our artifact: **the agent already has the search index.** ripgrep
is live, never stale, and free. What it does not have is the parsed-symbol layer — and that
layer is ~1% of the corpus, because it records only declarations. We should build the
navigation index and refuse to build a search index. Measured here: 151 KB of symbol index
for a repo whose `packages/` source is ~1.9 MB.

### 3.9 Serena / LSP-backed MCP — steal the tool vocabulary, reject the delivery mechanism

<https://github.com/oraios/serena> (27.8k stars). Pitch: *"The IDE for Your Coding Agent"* —
*"semantic code retrieval… operating at the symbol level"* rather than *"low-level concepts
like line numbers or primitive search patterns."* Tools: `find_symbol`,
`get_symbols_overview`, `find_referencing_symbols`, `replace_symbol_body`,
`insert_after_symbol`, plus a `search_for_pattern` fallback.

That tool list is a good specification of what an agent wants to ask. `find_symbol` →
`symbols.tsv`. `get_symbols_overview` → `grep '\tPATH:' symbols.tsv`.
`find_referencing_symbols` → `calls.tsv`.

But be honest about the claims. **The widely-repeated "~70% token savings" appears only in
third-party posts with no methodology; the README states no percentage.** The maintainers
themselves write: *"For small repos, Grep + Read + Edit are honestly fine, and zero extra
context cost"*, and *"in very small projects or in tasks that involve only one file… you may
not benefit from including Serena."* They removed their regex-replace tool from the Claude
Code integration because the built-in editor was better.

The structural point in our favour: **an MCP server's tool definitions occupy context in
every request whether used or not.** Serena exposes ~20 tools; that is a permanent tax against
a speculative saving. A *file* has the opposite cost profile — zero resident cost, paid only
when read. That is an argument for shipping `symbols.tsv` rather than an MCP server, and it is
the strongest argument this project has for existing in this space at all.

### 3.10 Does any of this actually work? — the honest answer

The strongest datapoint is **negative and it is about embeddings, not indexes.** Boris Cherny
(Anthropic): *"Early versions of Claude Code used RAG + a local vector db, but we found pretty
quickly that agentic search generally works better"*, and *"in our testing we found that
agentic search outperformed [it] by a lot, and this was surprising."* Corroborated by Colin
Flaherty (Augment, top SWE-bench Verified): *"We explored adding various embedding-based
retrieval tools, but found that for SWE-bench tasks this was not the bottleneck — grep and
find were sufficient."* Historical baseline: SWE-bench's RAG baseline scored 1.96%; SWE-agent,
replacing retrieval with tools, 12.47%.

**The strongest datapoint the other way is Cursor's, and it is a real A/B.** Against their
internal "Cursor Context Bench", with and without semantic search
(<https://cursor.com/blog/semsearch>): *"on average **12.5% higher accuracy** in answering
questions (**6.5%–23.5% depending on the model**)"*, and an A/B code-retention improvement
reaching *"2.6% on large codebases with 1,000 files or more."* Their conclusion is explicitly
not "index instead of grep": *"Our agent makes heavy use of grep as well as semantic search,
and the combination of these two leads to the best outcomes."* Vendor-published and
unreproducible, but it is a controlled comparison with a stated effect size, which is more than
anyone else in this space offers. Cursor also built a **local sparse n-gram index** because
ripgrep was too slow in large monorepos — so neither camp is index-free at the extremes.

Two more datapoints worth recording because they cut against the thing we are building:

- **Aider publishes no ablation for its repo map at all** — extensive edit-format and model
  leaderboards, nothing isolating map on/off — and ships `use_repo_map` **off by default for
  many models** (§3.1). The most-cited codebase-map implementation has never demonstrated that
  it helps.
- **Codex has no index and its users are asking for one**
  ([openai/codex#5181](https://github.com/openai/codex/issues/5181), open, no maintainer
  response): *"it struggles to reliably find the right places in medium to large codebases
  because it lacks a first-class semantic search capability."* Demand is not evidence, but the
  absence of a maintainer response is a signal about how settled this question is not.

**I found no credible controlled study of grep vs. a symbol index.** State this plainly rather
than implying the evidence covers us. The defensible claim is: *a symbol index is not a
replacement for agentic search; it is a cheaper first hop that reduces the number of hops.*
Flaherty's own caveat points the same way — embeddings *"become essential for larger
codebases"* — as does Cursor's "1,000 files or more" threshold and the framing in
<https://www.nuss-and-bolts.com/p/on-the-lost-nuance-of-grep-vs-semantic>: grep wins for *"a
known or easily derived keyword"*, and you are *"trading latency and tokens for flexibility."*
Grep costs turns; precomputation costs freshness. The value of precomputation rises with repo
size, and this product's target is repos too large to explore by hand.

And the honest statement of what this project offers that neither alternative does: the index
is **deterministic, complete, offline, and produced with no model call and no index server**.
Aider needs a tree-sitter pass and an mtime-keyed SQLite cache on every turn; Cursor needs an
embedding service and a remote vector store. Our extraction already happened in phase 1. That
is the claim to make, and it is a claim about cost and reproducibility — not about accuracy,
which nobody has measured.

### 3.11 Format bake-off — measured

Identical payload (name, kind, path, line), 7,152 symbols from this repo:

| format | bytes | B/symbol | vs TSV |
|---|---:|---:|---:|
| **tab-separated** | 405,183 | **56.6** | 1.00x |
| markdown table | 491,007 | 68.7 | 1.21x |
| JSON-lines | 662,655 | 92.7 | **1.63x** |

With the full ctags payload including the `/^…$/` pattern, JSON's penalty grows to **2.13x** —
the more internal structure a field has, the worse JSON's escaping overhead gets.

Truncation at 60% of bytes: TSV loses exactly one partial final line, 4,285 of 7,068 records
survive fully interpretable. JSON-lines has the same line property but leaves an unparseable
trailing object. Graph JSON is catastrophic (surviving edges reference unread vertices).

Anchored grep for symbol `nav`:

| query | hits |
|---|---:|
| `grep '^nav\t'` | **5** (correct) |
| `grep 'nav'` | 82 |
| `grep '"name": "nav"'` | 5 |
| ``grep '\| `nav` \|'`` | 5 |

All three can express an exact match; only TSV does it with a **line-start anchor**, which is
the cheapest and most obvious query an agent will actually type. JSON and markdown require
knowing the exact serialization (spacing after the colon, backticks in the cell) — guess wrong
and you get zero hits, which is worse than too many.

**Markdown tables are disqualified for this repo specifically.** 338 lines of the ctags output
contain `|`, because TypeScript union types do (`string | undefined`). Every one breaks a
markdown cell and needs escaping — reintroducing exactly the quoting problem tabs avoid. And
the header row that gives columns meaning is stated once, at the top, so a grep hit or a
truncated slice is a row of unlabeled values.

**Decision: TSV, one fact per line, `LC_ALL=C` sorted, with a self-describing header and
self-labeling optional fields.** It won on size, on truncation, and on anchored-grep
ergonomics.

---

## 4. Proposed file set for `handbook/agent/`

All sample lines below are **real, generated from `examples/work/self/`**. Tabs are shown as
real tabs. Column order is value order throughout, because this repo's own planner truncates
grep lines at 200 chars (`truncate(line.trim(), 200)`) — 10% of symbol rows here exceed 200
chars, and with location at column 2 the truncation only ever clips the signature tail.

Two constraints that apply to every file below.

**Determinism.** Every byte must be a pure function of `HandbookModel` (plus provenance,
§6.2). No wall-clock ordering, no `Object.keys` iteration order, no ranking that depends on
anything outside the model. This is already how the rest of the repo works —
`docs-drift.test.ts` byte-compares generated files — and it is the failure aider hit when a
budget heuristic made its map churn between identical invocations (§3.1). Sorts are explicit
and `LC_ALL=C`.

**Key on the assignment, not the cards.** `model.cards` and `model.assignment.fileStage` do
not agree: this work dir has **169 cards for 167 assigned files**, and the extras are
`cli/src/args.ts` and `cli/src/args.test.ts` — files deleted by the config refactor whose
cards were never evicted. Anything keyed on `Object.keys(model.cards)` will emit two
non-existent paths, which is the worst possible defect in a file whose entire promise is
"this path exists". `assignment.fileStage` is the authoritative file set; `cards` is a
lookup. (Whether the pipeline should evict stale cards is a separate bug, not this
document's.)

```
handbook/agent/
  index.md          2.9 KB   always read; routing + recipes + coverage
  symbols.tsv       151 KB   grep target: symbol → location
  files.tsv          50 KB   grep target: file → stage, role, purpose
  calls.tsv         128 KB   grep target: resolved call edges
  stages/<sid>.md   0.8–7.4 KB each, 35 KB total   second hop
```

Total 367 KB, versus 715 KB today — but the number that matters is not disk. It is **bytes
into context for one task**, and that is where the ratio is large (§4.7).

### 4.1 `index.md` — budget **≤ 4 KB hard cap**; measured 2,899 B

This is the only file assumed to be always in context. Real output for this repo, abridged in
the middle only:

```markdown
# handbook — agent index

generated 2026-08-09 from 8c2f1ab | 167 files | 1059 symbols | 19 stages
facts below are parser-derived. model-written prose is marked (prose) wherever it appears.

## lookup

symbol -> location     grep -m5 "^NAME	" symbols.tsv
file   -> its symbols  grep "	PATH:" symbols.tsv
callers of a symbol    grep "	NAME	" calls.tsv
file   -> stage, role  grep "^PATH	" files.tsv
stage  -> its files    read stages/<sid>.md

## stages

sid	files	symbols	path prefixes
analyzer_adapters	32	559	analyzer/src/adapters/ analyzer/src/
call_graph_construction	3	16	analyzer/src/ pipeline/src/
config_and_cli_parsing	23	63	core/src/config/ cli/src/
core_data_model	4	10	core/src/
crosscut_infra	25	134	core/src/util/ llm/src/
…
rendering_html	2	25	renderer/src/
studio_server	6	59	studio/src/

## state registers

reg-ir-call-graph	core_data_model,analyzer_adapters,call_graph_construction,pipeline_phase1,member_tagging,pipeline_generation,planner_proposal,resync_handbook
reg-patch-plan	planner_proposal,patcher_apply_and_rollback
reg-studio-registry	studio_server,studio_frontend
…

## coverage

134/167 files routed to a stage; 33 unrouted (stage=unassigned in files.tsv).
42 of 167 files contribute no symbol rows: the parser found no functions in them.
```

Why these fields and no others:

- **The freshness line is mandatory.** We are now emitting line numbers as the primary
  payload (§2.4). Needs `HandbookModel` provenance — see §6.2.
- **`## lookup` replaces `how_to_use.md` entirely.** Merged in, not linked. Rationale from
  §3.2: an index nobody is told about is not read, and a recipe one hop away is a recipe not
  followed. Five lines beats a 1,125-byte file plus a routing step.
- **Path prefixes replace `入口概念`.** `analyzer/src/adapters/` is greppable, globbable, and
  wireable to a Cursor `globs:` / Claude Code `paths:` rule (§3.4). `registry` is none of
  those. Computed as the top-2 directories by file count in the stage's bucket.
- **Symbol count per stage, not per file.** It answers "is this stage worth a hop", which is
  the only question the index is asked. Per-file counts belong in `files.tsv`.
- **The register table stays**, unchanged in substance. It is the one thing in the current
  index that is dense, id-anchored, and not reproducible by grep. It costs 1,547 B and earns it.
- **Coverage stays**, and gains a second line: 42 files have no symbol rows. Invariant 1's
  "never drop" applies to the new index too — a symbol index that silently omits 25% of files
  will be read as "those files have no code".

Budget justification. Anthropic's context-window table puts a project CLAUDE.md at ~1,800
tokens with total startup ~7,850 / 200,000 ≈ 3.9% (explicitly labelled illustrative). This
file is paid on **every session and every subagent spawn** — *"The subagent loads CLAUDE.md
too. Same file, same content, but it counts against the subagent's context."* 4 KB ≈ 1,000–1,400
tokens here, i.e. under one file read, and under the 200-line target. The current 33,497 B
index is roughly 8x that.

Scaling. The stage table is **O(stages)**, not O(files) — that is the whole point. 60 stages
at ~50 B/row is 3 KB. Degradation rule when the cap would be exceeded: emit top-level stages
only and put children in the parent's `stages/<sid>.md`. Never truncate mid-table without
saying so.

### 4.2 `symbols.tsv` — budget **~143 B/symbol**; measured 150,984 B / 1,059 rows

Sorted `LC_ALL=C` on column 1. Columns, value-ordered:
`name TAB path:startLine-endLine TAB kind TAB stage TAB nCalledBy TAB signature`

Real rows:

```
abortableSleep	llm/src/client.ts:464-476	fn	crosscut_infra	1	function abortableSleep(ms: number, signal?: AbortSignal): Promise<void>
buildCollisionIndex	renderer/src/agent-site.ts:264-286	fn	rendering_agent_site	1	function buildCollisionIndex(view: HandbookView): Map<string, string[]>
renderHtmlSite	renderer/src/html.ts:599-696	fn	rendering_html	0	function renderHtmlSite( model: HandbookModel, outDir: string, options: RenderOptions = {}, ): { nPages: number }
strongTwins	renderer/src/agent-site.ts:220-233	fn	rendering_agent_site	1	function strongTwins(rel: string, allFiles: readonly string[]): string[]
```

Ambiguity becomes visible instead of hidden — `grep "^scan	" symbols.tsv`:

```
scan	analyzer/src/adapters/cpp.ts:1478-1480	method	analyzer_adapters	0	…
scan	analyzer/src/adapters/csharp.ts:924-950	method	analyzer_adapters	0	…
scan	analyzer/src/adapters/dart.ts:1647-1666	method	analyzer_adapters	0	…
…13 rows
```

Thirteen rows, ~1.5 KB, every one actionable — against 576 hits / 56.9 KB from
`grep scan analyzer_adapters.md` today.

Header line, stolen from ctags (§3.5), sorting first under C collation:

```
!_HANDBOOK_TSV	symbols	1	name<TAB>path:lines<TAB>kind<TAB>stage<TAB>nCalledBy<TAB>signature
!_HANDBOOK_SORT	LC_ALL=C on col 1
!_HANDBOOK_SOURCE	8c2f1ab	2026-08-09
```

`LC_ALL=C` must be declared: a locale-dependent sort silently breaks binary search and is
invisible on inspection.

Also emit a **second row per method carrying the qualname**, ctags `--extras=+q` style, so
`grep "^StageTree.title	"` works and `constructor` (×28 here) is disambiguable. Cost: +186
rows / ~26 KB on this repo. Qualname alone is still ambiguous 84 times (module-relative), so
the fully unique key remains the node id — keep that out of the file; it buys nothing an agent
can type.

Signature goes last on purpose (§4 preamble). Including it costs +63 KB (88 KB → 151 KB) and
the cost is only paid on a grep hit, where it is the difference between "read the function"
and "no need". Keep it.

Never read whole. If a repo is large enough that `symbols.tsv` exceeds a few MB, that is fine
— nothing changes, because nothing reads it whole. Do not add a size cap; add the header so a
consumer knows what it is looking at.

### 4.3 `files.tsv` — budget **~300 B/file**; measured 49,938 B / 169 rows (167 once keyed correctly)

`path TAB stage TAB role TAB lifecycle TAB nSymbols TAB purpose(prose, ≤120 chars)`

```
analyzer/src/adapter.ts	analyzer_adapters	orchestration	运行时	7	这是分析器的"翻译官"大本营。它定义了怎么把各种编程语言的源码变成统一中间格式（IR）的契约…
renderer/src/html.ts	rendering_html	io_transport	build_output	25	把代码手册的数据模型渲染成带侧边栏、面包屑和搜索框的静态 HTML 网站…
```

This is the only place model prose survives in bulk, one clipped line per file, in the last
column so truncation eats prose first and never a path. Without the purpose column the file
is 19,016 B; the prose costs 31 KB and is what makes a file list skimmable. That trade is
worth it here and nowhere else.

`lifecycle` is emitted only if it is short — see §2.3; today it is not, and shipping it as a
column would produce 200-char rows. Either fix the prompt or drop the column.

The 33 unrouted files appear here with `stage=unassigned`, which is how the "never drop"
half of invariant 1 is honoured without a separate section.

### 4.4 `calls.tsv` — budget **~92 B/edge**; measured 128,149 B / 1,398 edges

`callerQualname TAB callerPath:line TAB calleeQualname TAB calleePath:line`

```
CPP_SPEC.buildIndexes	analyzer/src/adapters/cpp.ts:1489	dedupeFunctionsById	analyzer/src/adapter.ts:87
CPP_SPEC.buildIndexes	analyzer/src/adapters/cpp.ts:1489	materialize	analyzer/src/adapters/cpp.ts:1037
```

This is the blast-radius file, and it is the one that grep on source cannot replace: a text
search for `scan(` finds 13 different functions' call sites, whereas these edges are
*resolved* — and per invariant 2, an edge the analyzer could not resolve is not here at all,
it is in `dropped-calls.json`. That is the differentiator, and it should be stated in the
header rather than assumed.

Both directions are answerable from one file: `grep "	NAME	"` (tab-delimited, so anchored)
finds NAME as callee; `grep "^NAME	"` finds it as caller.

Degradation rule if a cap is ever needed: drop `test → src` edges first (they are the
highest-count, lowest-value class), and say how many were dropped. Never silently truncate.

I am least sure about this file — see §7.2.

### 4.5 `stages/<sid>.md` — budget **≤ 16 KB soft**; measured 0.8–7.4 KB, 35,204 B total

Real output, whole file, for `rendering_html` (801 B, against 16,951 B today):

```markdown
# rendering_html

2 files | 25 symbols | registers: reg-final-config reg-stage-tree reg-workdir reg-rendered-handbook
symbols in this stage: grep "	rendering_html	" ../symbols.tsv
prose (model-written): ../../rendering_html.md

## files (path, role, symbols, purpose[prose])

renderer/src/html-assets.ts	data_model	0	为生成的离线 HTML 手册提供全套内置的前端资源，包括图标、样式和交互脚本…
renderer/src/html.ts	io_transport	25	把代码手册的数据模型渲染成带侧边栏、面包屑和搜索框的静态 HTML 网站…

## co-change (source ↔ its test)

renderer/src/html.ts	renderer/src/html.test.ts
```

Sizes against today:

| stage | proposed | current | ratio |
|---|---:|---:|---:|
| `rendering_html` | 801 B | 16,951 B | 21x |
| `config_and_cli_parsing` | 5,324 B | 59,945 B | 11x |
| `analyzer_adapters` | 7,407 B | 313,356 B | **42x** |
| all 19 | 35,204 B | 715,456 B | 20x |

The per-function detail is gone because it lives in `symbols.tsv`, indexed by the key the
agent actually has (the symbol name) rather than the key it is trying to find (the stage).

Budget justification: ~120 B/file, so 16 KB ≈ 130 files in one stage. Beyond that, split by
organization group. The soft cap exists so a single mega-stage cannot recreate the 313 KB
page.

Kept from the current locator block: **co-change** (`strongTwins`) — genuinely useful, purely
structural, and not derivable by grep. **Exemplar** — see §7.4; I would keep exactly one, in
the header line, not a per-group list. Dropped: 相关, 核心文件, 入口概念, the duty paragraph
(§5).

### 4.6 Model prose: **one clipped line inline, the paragraph behind a hop, and marked either way**

Invariant 1 says facts and prose are never mixed. The current agent artifact violates the
spirit of it — the duty paragraph sits in the same visual block as the co-change pairs with
no marking, and `how_to_use.md`'s trust-boundary paragraph is the only thing telling the agent
which is which, one hop away.

Proposal, and I think this is the right answer to your question:

1. **Not cut entirely.** The one-sentence purpose is what makes a 169-row file list skimmable,
   and it is what `disambiguation.md` already proved useful at 160 chars.
2. **Reduced to one clipped line**, in the **last column** of `files.tsv` and the stage page's
   file table, so truncation eats prose before it eats a path.
3. **The paragraph moves behind a hop, and the hop points at the human page** —
   `../../rendering_html.md` — rather than a duplicate `prose/` directory. The prose already
   exists there, and duplicating it is how we got here. (Caveat: this only works when both
   directories ship together; see §6.1 on `buildSkill`.)
4. **Marked, mechanically.** Column headers say `purpose[prose]`; the index header says
   *"facts below are parser-derived; model-written prose is marked (prose) wherever it
   appears."* This is cheaper than it sounds — it is a header string, not a per-row flag — and
   it makes the trust boundary a property of the format instead of a paragraph in a file the
   agent may not have read.

There is a second-order argument for this, from Chroma's context-rot study (18 models,
<https://www.trychroma.com/research/context-rot>): *"Even a single distractor reduces
performance relative to the baseline… adding four distractors compounds this degradation."*
A metaphor about a coffee machine sitting next to the file list is a distractor in the
technical sense — semantically near, factually irrelevant. Their headline finding is the one
to quote in a design review: *"Whether relevant information is present in a model's context
is not all that matters; what matters more is how that information is presented."*

### 4.7 The number that actually matters

Task: *"add a Kotlin language adapter."*

| | current | proposed |
|---|---:|---:|
| read entry index | 33.5 KB | 2.9 KB |
| route to `analyzer_adapters` | — | — |
| read the stage page | 313 KB — refuses; agent greps instead | 7.4 KB |
| `grep scan` / `grep "^scan\t"` | 56.9 KB (capped at 100 hits, lines cut at 200 chars) | ~1.5 KB |
| find the exemplar's symbols | not possible from the index | `grep "	analyzer/src/adapters/rust.ts:" symbols.tsv` → 30 rows, ~4 KB |
| **into context** | **≥ 90 KB, none of it a symbol location** | **~16 KB, all of it actionable** |

---

## 5. Delete list

| delete | why |
|---|---|
| The duty paragraph in every locator block | 42.4% of index bytes; byte-identical to the human page; only its first sentence routes (§1.1). Replaced by the ≤120-char purpose column. |
| `相关` (Related) — all 50 lines | Emits group titles and file counts, **no paths**. Unactionable by construction (§1.4). |
| `核心文件` (Core files) — all 70 entries | 86% overlap with Exemplar, and its ranking puts 0-function files above 25-function files (§1.2). `files.tsv` sorted by symbol count supersedes it. |
| `入口概念` (Entry concepts) — all 70 tokens | Bare basenames; 50% ambiguous across the repo; 14% are test-file stems from the `.test` stripping bug (§1.5). Replaced by path prefixes. |
| Per-function detail on stage pages (`renderFileCardMd`) | 559 blocks on one page; facts split across non-adjacent lines; sharded by the wrong key. Moves to `symbols.tsv` (§1.6). |
| `how_to_use.md` as a separate file | 1,125 B and a routing hop for five recipes. Merged into `index.md`'s `## lookup` (§4.1). |
| `disambiguation.md` as a separate file | One entry on this repo (435 B), indexes stage-title tokens only, misses the real ambiguity (`scan` ×13). `symbols.tsv` surfaces ambiguity for free (§2.6). Delete the file; keep a `collides` marker in the stage table if the collision index survives at all. |
| Six of the eight `LABELS` translations, and both hand-written `howToUseMd` bodies | ~27% of `agent-site.ts`. A fact format needs English column names, not translated field labels (§2.5). Prose that stays (the purpose column) is already in `model.lang`. |
| `leafName()` in the agent artifact's call facts | Collapses a resolvable `(file, line)` to an ambiguous bare name 12% of the time (§2.2). |

Two things I would **not** delete, though they look deletable:

- **The register table.** Dense, id-anchored, not reproducible by grep or by reading one file.
  Keep verbatim.
- **Strong co-change.** Purely structural, cheap, and the single highest-value "what else do I
  touch" signal in the current output. Keep, on the stage page.

---

## 6. What `HandbookModel` does not carry

Ordered by value-per-cost. Only the first two are worth paying for.

### 6.1 Nothing at all, for the core of the redesign

Worth stating first, because it changes the cost estimate: `symbols.tsv`, `files.tsv`,
`calls.tsv`, the stage table and the path prefixes are **all derivable from today's
`HandbookModel`**. Measured: `FunctionNote` gives name/qualname/className/lineRange/signature;
`assignment.fileStage` gives the stage; `FileCard` gives role/lifecycle/purpose; and
**2,713 of 2,714 call-edge endpoints resolve to `(file, line)` using only `model.cards`**
(§2.2). This is a renderer change, not a model change.

The one wiring change outside the renderer: `buildSkill`'s `AGENT_LOCATOR_PAGES` must ship the
new files and `SKILL.md`'s routing protocol must name them (§2.1).

### 6.2 Provenance — **needed, cheap, do it**

No commit sha, no timestamp, no content hash on `HandbookModel`. We are about to make line
numbers the primary payload, and the checked-in example is already 167 lines stale (§2.4).

Minimal addition:

```ts
export interface HandbookModel {
  …
  /** How this model was produced. Rendered into every agent-facing header. */
  provenance?: { commit?: string; generatedAt: string };
}
```

Optional so every existing work dir still loads. `run-manifest.json` already exists in the work
dir; this is plumbing it through, not computing anything new.

### 6.3 Type / class / interface symbols — **the real gap, and it is expensive**

`packages/core/src/ir.ts` has `functionNodeSchema` and `boundaryNodeSchema` and nothing else.
There is no node kind for a type. Measured consequence on this repo — exact column-1 matches
in the prototype index:

| symbol | rows |
|---|---:|
| `HandbookModel` | 0 |
| `StageTree` | 0 |
| `FileCard` | 0 |
| `FunctionNote` | 0 |
| `LanguageAdapter` | 0 |
| `ChatClient` | 0 |

`core/src/model.ts` yields eight rows — `children`, `coerceRole`, `constructor`, `depth`,
`description`, `isCrosscut`, `subtree`, `title` — and not the two things the file is *for*.
For a TypeScript, Java, Go, Rust or C# codebase this is a large fraction of what an agent
looks up. It is the difference between a symbol index and a function index.

Cost: a new IR node kind touches `ir.ts`, `graph.ts`, the cards pass, and **every one of the
13 language adapters plus the generic engine**. That is expensive, and it is a separate piece
of work from this redesign.

Cheap interim, available today: derive a `class` row from `className` — 45 distinct
`(file, className)` pairs here, with a line span from `min(lineStart) … max(lineEnd)` of the
methods. But that span is **derived, not parsed**: it is where the methods are, not where the
declaration is. Under invariant 1 it must be labelled as such (`kind:class-derived`) or not
emitted. And it covers only 186 of 1,059 symbols and zero interfaces, so it does not close the
gap — it just makes `StageTree` findable.

**Recommendation: do the interim derivation, label it, and disclose the gap in `index.md`'s
coverage section** — the same way analysis fidelity is disclosed per adapter (invariant 3).
A line saying *"symbols.tsv contains functions and methods only; types, interfaces and
constants are not indexed"* is worth more than a silently partial index, because an agent that
greps `^HandbookModel\t`, gets nothing, and concludes the type does not exist is the
"wrong pointer" failure this whole design is trying to avoid.

### 6.4 Per-file language — **cheap, and invariant 3 wants it**

`FidelityOptions.languages` is `name → AdapterCapabilities`; there is no `file → language`.
So generic-tier fidelity can only be disclosed as a global note ("call relations for X are
best-effort"), never on the row that is affected. Adding `FileCard.language?: string` would let
`files.tsv` carry a `tier` column and put the caveat on the line the agent reads. Small, and
squarely in line with "analysis fidelity is declared per adapter and disclosed in the output".

### 6.5 Explicitly not recommended

- **File line counts.** Would tell an agent whether a ranged read is needed. The renderer must
  not stat source, so it would mean a new `FileCard` field. Low value; `lineRange` already
  bounds the read.
- **Import / module edges.** Would answer "what depends on this file's exports". Genuinely
  useful and genuinely an IR change. `calls.tsv` approximates it at function granularity. Not
  now.
- **Exported-ness / visibility.** `functionNodeSchema` has `isAsync`, `isMethod`, `decorators`
  — no visibility. Would improve ranking (public API vs private helper). Medium value, adapter
  change. Not now.

---

## 7. Open questions and trade-offs

Stated as questions because I do not know the answers.

**7.1 Line numbers or search patterns?** (See also the argument against in §3.1: aider emits
verbatim source lines and its own FAQ reports models trying to *edit* code that exists only in
the map.) ctags emits `/^export interface HandbookModel {$/`
instead of a line number *because line numbers go stale* — and the checked-in example here is
already stale by 167 lines. A pattern is self-verifying: it either matches or it visibly does
not. But `HandbookModel` carries `signature`, which is a **normalized** string produced by the
analyzer (`function renderHtmlSite( model: HandbookModel, outDir: string, options: RenderOptions = {}, ): { nPages: number }` — reflowed onto one line), so it will not match the
source byte-exactly. Emitting it as a "search hint" is either (a) a useful degradation when the
line number misses, or (b) a fabricated anchor of exactly the kind invariant 4 refuses in the
patcher. Which is it? Options I can see: emit line numbers plus provenance and accept staleness;
add a `defLine` verbatim-source field to the IR (adapter change); or emit line numbers and tell
the agent, in the header, to fall back to `grep "^function NAME"` on the file when the range
looks wrong. I lean to the third, but it is a judgement call about how much unverifiable
guidance the artifact should carry.

**7.2 Should `calls.tsv` exist?** 128 KB for 1,398 edges is the largest single fact file, and
the agent has grep over real source, which is never stale. The argument for is that the
analyzer's edges are *resolved* where grep's are textual, and that this repo's whole
credibility rests on resolved-not-guessed (invariant 2). The argument against is that a stale
resolved edge is more dangerous than a fresh textual one, precisely *because* the agent will
trust it more. Is "who calls this" a question agents actually ask often enough to pay 128 KB
and a staleness risk for? I do not have data either way.

**7.3 Is the stage abstraction a liability in the agent artifact?** Stages are model-authored.
Symbols, paths and line ranges are parser facts. The artifact's own trust boundary says trust
the anchors, verify the prose — yet the proposed `index.md` routes primarily through a
model-authored tree, and `symbols.tsv` carries a `stage` column that is model-authored sitting
between two parser columns. Should the agent index route by **directory** (a parser fact) with
stages as a secondary annotation? The path-prefix column in §4.1 hints that directories are
already doing most of the routing work: 15 of the 19 stages map to a single package directory,
and `analyzer/src/adapters/` alone is one whole stage. That is a real argument that the stage
layer is mostly re-deriving the directory tree, at the cost of an LLM pass and a trust caveat.
I could not settle this.

**7.4 What is the right exemplar, and is one enough?** "Copy this shape when adding a new one"
is the single most agent-specific idea in the current design and I do not want to lose it. But
today it emits one per organization group (43 entries) chosen by max function count, which is
why `analyzer/src/adapters/dart.ts` (61 functions) is the exemplar for adapters rather than a
median one — the largest file is usually the *worst* thing to copy. Should the exemplar be the
**median** by function count within a group? The most recently changed? The one with the
highest ratio of `calledBy` from outside its own file? I have no evidence for any of these.

**7.5 English-only fact files, even when `model.lang` is `zh`?** Paths, symbols, roles, stage
ids and register ids are already language-neutral; only column names and the purpose column
carry language. Emitting `name path kind stage` as English column names in a Chinese handbook
is inconsistent with the current design and, I think, correct — but it is a product decision,
not a technical one.

**7.6 Does anything read this artifact today?** There is no telemetry and no consumer test
beyond `agent-site.test.ts` asserting the renderer's own output shape. The prior art says
passive discovery measures at ~zero and in-band advertisement measures well (§3.2), and today
`SKILL.md` advertises the *human* pages. Before optimizing the format further, it may be worth
answering whether the current artifact is used at all — `handbook plan` runs against a real
sandbox with `grep`/`read_file`, so a controlled A/B (plan quality with the agent dir present
vs absent) is buildable inside this repo and would be the only non-vendor evidence in this
whole document.

**7.7 Where does the 200-char truncation belong?** I ordered columns by value because
`packages/planner/src/tools.ts` truncates grep lines at 200 chars, and 10% of symbol rows
exceed it. But that constant is *ours*. Other hosts truncate differently or not at all.
Designing the column order around one consumer's constant is either good engineering (we ship
that consumer) or overfitting (nobody else has that limit). It is cheap either way, which is
why I did it — but it is not principled.

# LLM reply-shape / truncation fixes — adversarial review R1

Scope: `1422494~1..HEAD` (8 commits, 19 files).
Method: every finding below was reproduced by running code against the built `dist/`.
The whole existing suite passes (`npx vitest run` → 24 files / 260 tests green), so
none of these are caught by the tests shipped with the change.

All proof snippets are self-contained; write them to a file and run with `node`.
Paths are absolute so they can be pasted anywhere.

---

## Summary

The three defect classes named in the commits are real and the direction is right.
But the two headline mechanisms are **each half-built, and they compose into the
original bug rather than closing it**:

- `repairJson`'s terminator rule ("a `"` ends the string iff the next non-space
  character is structural") is exactly inverted for the most common way prose
  punctuates a quoted term — `…"list", …` and `…"queue": …`. It repairs 6 of 10
  realistic prose fragments and **fails on the 4 that matter**, including the
  gloss pattern the DEEP card prompt explicitly instructs the model to produce
  ("explain jargon inline on first use").
- When the repair fails, `extractJsonBlock` falls through to `scanBalanced`,
  which is still ahead of the repair pass for unfenced text and is the *only*
  remaining path for a fenced block whose repair failed. It returns the first
  parseable **nested fragment** — precisely the failure the commit message says
  it is fixing.
- The new *shape tolerance* then legitimises that fragment. `extractEntryList`'s
  `single: {fields: […]}` accepts any object carrying one generic key, so a
  nested `functions[0]` note becomes a file card (F1) and a nested `stages[0]`
  object becomes a one-chapter handbook (F2). Both make the new
  "explain your own failure" guards pass on garbage.

Net effect: the exact user-visible symptom that started this work — *cards that
are wrong/empty while the run reports success* — is still reachable, now with
`nDescribed` reporting 100 % and **zero warnings and no `_rejected` reply**.

Separately, the truncation fix contains a run-killer: one truncated response
anywhere on a client permanently inflates every later retry's `max_tokens`, and
an endpoint that rejects the inflated value returns 400 → `PermanentError` → the
retry loop aborts after 2 of 6 attempts (F3).

**Counts: 4 high, 7 medium, 3 low.**

---

## Findings

### 1. [high] A nested `functions[0]` note is written as the file's card; coverage reports 100 % described, with no warning and no `_rejected` reply

`repairJson` cannot repair a `"`-before-`:` gloss, so `extractJsonBlock` falls to
`scanBalanced`, which returns the nested `functions` array. `extractCardEntries`
accepts a bare array of objects, and `extractEntryList`'s
`single: {fields: ['purpose', …]}` means the function note passes as a card
entry. With `batch.length === 1` — the default for deep mode
(`batchSize` doc: *"Use 1 for deep mode"*), the tier-2 single-file retry, and
**every resync** (`packages/resync/src/resync.ts:331` passes `batchSize: 1`) —
`cards.ts:341` attributes it to `soleFile` regardless of what the reply named.

```sh
cat > /tmp/p1.mjs <<'EOF'
import { extractJsonBlock, repairJson } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
import { extractCardEntries } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/cards.js';
const reply = [
  '```json',
  '{"purposes": [{"file": "app/queue.py", "purpose": "Holds work that is waiting.",',
  '  "description": "A "queue": a waiting line. Jobs join at the back.",',
  '  "functions": [{"qualname": "Queue.push", "purpose": "Adds a job to the back of the line.", "data_flow": "job in", "relations": "called by the producer"}],',
  '  "role": "data_model", "lifecycle": "main loop"}]}',
  '```',
].join('\n');
console.log('repairJson(fence)  :', repairJson(reply.split('\n').slice(1, -1).join('\n')) === undefined ? 'undefined (repair FAILED)' : 'repaired');
console.log('extractJsonBlock   :', JSON.stringify(extractJsonBlock(reply)));
console.log('extractCardEntries :', JSON.stringify(extractCardEntries(extractJsonBlock(reply))));
EOF
node /tmp/p1.mjs
```

```
repairJson(fence)  : undefined (repair FAILED)
extractJsonBlock   : [{"qualname":"Queue.push","purpose":"Adds a job to the back of the line.","data_flow":"job in","relations":"called by the producer"}]
extractCardEntries : [{"qualname":"Queue.push","purpose":"Adds a job to the back of the line.","data_flow":"job in","relations":"called by the producer"}]
```

End-to-end through `generateCards` (deep, `batchSize: 1`, single-file repo, same
reply): the observed card is

```json
{"version":1,"file":"src/core/index.ts","purpose":"Adds a job to the back of the line.",
 "role":"other","lifecycle":"none","description":"","functions":[]}
```

with `coverage = {"nFiles":1,"nDescribed":1,"missing":[]}`, `warnings = []`, and
`phase2/cards/_rejected` absent. So: `purpose` is a *function's* purpose, the
real `description`/`role`/`lifecycle` are lost, the per-function annotations are
gone — and every signal the commits added says the run succeeded.

Reproduce the end-to-end half with:

```sh
cat > /tmp/p1b.mjs <<'EOF'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCards } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/cards.js';
import { WorkDir } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/workdir.js';
import { extractJsonBlock } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
const files = ['src/core/index.ts'];
const repo = mkdtempSync(join(tmpdir(), 'hb-'));
mkdirSync(join(repo, 'src/core'), { recursive: true });
writeFileSync(join(repo, files[0]), '// x\n');
const graph = { version: 1, nodes: {}, edges: [], selfAttrs: {},
  metadata: { generatedAt: '', language: 'ts', sourceRoot: repo, scannedFiles: files,
              nInternalFunctions: 0, nBoundaryNodes: 0, nEdges: 0, policy: 't' } };
const reply = [
  '```json',
  '{"purposes": [{"file": "src/core/index.ts", "purpose": "Holds work that is waiting.",',
  '  "description": "A "queue": a waiting line. Jobs join at the back.",',
  '  "functions": [{"qualname": "readConfig", "purpose": "Adds a job to the back of the line.", "data_flow": "job in", "relations": "called by the producer"}],',
  '  "role": "data_model", "lifecycle": "main loop"}]}',
  '```',
].join('\n');
const client = { model: 'p', async complete() { return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 }; } };
const warnings = [];
const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hbw-')));
const res = await generateCards({ client, graph, sourceRoot: repo, work, batchSize: 1, detail: 'deep',
  logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} } });
console.log('card    :', JSON.stringify(res.cards['src/core/index.ts']));
console.log('coverage:', JSON.stringify(res.coverage));
console.log('warnings:', JSON.stringify(warnings));
console.log('_rejected:', existsSync(join(work.cardsDir, '_rejected')));
EOF
node /tmp/p1b.mjs
```

```
card    : {"version":1,"file":"src/core/index.ts","purpose":"Adds a job to the back of the line.","role":"other","lifecycle":"none","description":"","functions":[]}
coverage: {"nFiles":1,"nDescribed":1,"missing":[]}
warnings: []
_rejected: false
```

Expected: either the repaired full answer (it *is* repairable — see F2's
suggestion), or a rejected reply plus an empty card counted in `missing`. Never a
function note promoted to a file card.

Two independent fixes, either of which breaks the chain:
- run the `balancedSpans`+`repairJson` pass **before** `scanBalanced`, not after —
  the docstring already argues for exactly this ordering, it just wasn't applied
  to the unfenced/failed-fence path;
- make `extractCardEntries` reject an entry that carries `qualname`/`data_flow`
  (i.e. is obviously a function note) and require at least one card-shaped field
  beyond the generic `purpose`.

---

### 2. [high] `repairJson` fails on the two most common prose-quote patterns (`",` and `":`), including the one the DEEP prompt asks for

The terminator rule is: a `"` closes the string iff the next non-space character
is `,` `:` `}` `]` or EOF. Inside prose, a quoted *term* is almost always followed
by exactly those characters. So the heuristic is inverted for the common case.

```sh
cat > /tmp/p2.mjs <<'EOF'
import { repairJson } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
const frags = ['the "config" file', 'supports "list", "map" and "filter"',
  'she said "no", then left', 'the flag is "verbose"', 'a "queue": a waiting line',
  'known as the "front door"', '"main" is where it starts', 'ends with a "quote"',
  '解析 "配置" 文件', 'reads "cfg", writes state'];
for (const f of frags) {
  const intended = { purposes: [{ file: 'a.ts', purpose: f, role: 'util' }] };
  const wire = JSON.stringify(intended, null, 2).replace(/\\"/g, '"'); // model forgot to escape
  const got = repairJson(wire);
  console.log(got === undefined ? 'FAIL ' : JSON.stringify(got) === JSON.stringify(intended) ? 'ok   ' : 'WRONG', JSON.stringify(f));
}
EOF
node /tmp/p2.mjs
```

```
ok    "the \"config\" file"
FAIL  "supports \"list\", \"map\" and \"filter\""
FAIL  "she said \"no\", then left"
ok    "the flag is \"verbose\""
FAIL  "a \"queue\": a waiting line"
ok    "known as the \"front door\""
ok    "\"main\" is where it starts"
ok    "ends with a \"quote\""
ok    "解析 \"配置\" 文件"
FAIL  "reads \"cfg\", writes state"
```

`a "queue": a waiting line` is not a contrived input — `DEEP_RULES_EN` says
*"explain jargon inline on first use"* and `DEEP_RULES_ZH` says
*"术语首次出现要顺手解释"*. The prompt is asking for the pattern the reader cannot
parse. Every FAIL here becomes F1 (a fragment) or an empty card.

Expected: a repair that recovers all ten, i.e. don't commit to one
interpretation at an ambiguous quote — try "terminator" and on a parse failure
retry that quote as "escaped" (bounded backtracking over the ambiguous quotes,
which are few), or run the repair right-to-left knowing the value's real
terminator is the last quote before the next structural token at the same depth.

---

### 3. [high] One truncated response anywhere permanently inflates every later retry, and an endpoint that rejects the inflated `max_tokens` turns retryable failures into `PermanentError` — 2 attempts instead of 6

`sawTruncation`/`sawReasoning` are **instance** fields, so with the default
`concurrency: 16` one truncated reply poisons the budget for every other call on
the client. `growth = Math.min(4, attempt)` then sends 2×/3×/4× `maxTokens`, and
`Math.min(200_000, …)` is far above every real model's output cap. A 400 from
`max_tokens` validation has a JSON body, so `looksLikeGatewayPage` doesn't
rescue it: `PERMANENT_STATUSES.has(400)` → `PermanentError` → `retry()` aborts
immediately.

```sh
cat > /tmp/p3.mjs <<'EOF'
import { OpenAiChatClient } from '/Users/jack/Desktop/share/handbook/packages/llm/dist/client.js';
const CAP = 16384; const seen = [];
let n = 0;
const client = new OpenAiChatClient({
  config: { apiKey: 'EMPTY', model: 'glm-5.2', maxTokens: 16000, maxRetries: 6, retryBackoffMs: 0 },
  fetchImpl: async (_u, init) => {
    n += 1; const b = JSON.parse(init.body);
    seen.push({ call: n, prompt: b.messages[0].content, max_tokens: b.max_tokens });
    if (b.max_tokens > CAP) return new Response(JSON.stringify({ error: { message: 'max_tokens too large' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (b.messages[0].content === 'file-1') return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'partial…' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'content-type': 'application/json' } });
  },
});
try { await client.complete('file-1'); } catch (e) { console.log('file-1:', String(e.message).slice(0, 60)); }
try { await client.complete('file-2'); } catch (e) { console.log('file-2:', e.constructor.name, '-', String(e.message).slice(0, 60)); }
console.log('requests:', JSON.stringify(seen));
EOF
node /tmp/p3.mjs
```

```
file-1: LLM endpoint returned 400: {"error":{"message":"max_tokens t
file-2: PermanentError - LLM endpoint returned 400: {"error":{"message":"max_tokens t
requests: [{"call":1,"prompt":"file-1","max_tokens":16000},{"call":2,"prompt":"file-1","max_tokens":32000},{"call":3,"prompt":"file-2","max_tokens":16000},{"call":4,"prompt":"file-2","max_tokens":32000}]
```

`file-2` never truncated — its first attempt hit an ordinary retryable 429 —
and it still died permanently on attempt 2 because an unrelated earlier call had
set `sawTruncation`. `HANDBOOK_LLM_MAX_RETRIES=6` was configured; 2 requests were
made. On a 90-file run with 16 workers this converts a recoverable rate-limit
episode into a dead run, and the error message ("raise `OPENAI_MAX_TOKENS` if
this persists") makes it *more* likely by raising the base the growth multiplies.

Expected: (a) growth is per-call state, not per-client; (b) a 400 whose body
mentions the token parameter should shrink the budget back and stay retryable,
or the growth should be capped by a learned per-model ceiling; (c) never exceed a
configured `OPENAI_MAX_OUTPUT_TOKENS`-style hard cap instead of 200 k.

---

### 4. [high] A skeleton reply with one unescaped quote collapses a 4-chapter handbook into 1 chapter, silently — the new "explain your own failure" guard cannot fire

`normalizeSkeleton` now reads stages through `extractEntryList(raw, [...], {single: {fields: ['id','title']}})`.
When the reply's outer object doesn't parse, `scanBalanced` returns the first
parseable nested object — `stages[0]` — and `single` accepts that lone stage as a
1-item list. `skeleton.stages.length === 0` is therefore false, so
`synthesizeSkeleton` neither throws nor calls `onRejected`, and the run continues
with a one-chapter spine into which `assignFiles` files every file.

```sh
cat > /tmp/p4.mjs <<'EOF'
import { extractJsonBlock } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
import { normalizeSkeleton } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/skeleton.js';
const reply = ['```json', '{', '  "stages": [',
'    {"id": "stage-1", "title": "Boot", "description": "The wiring that runs before any work.", "parent": null, "crosscut": false},',
'    {"id": "stage-2", "title": "Queue", "description": "A "queue": a waiting line for jobs.", "parent": null, "crosscut": false},',
'    {"id": "stage-3", "title": "Workers", "description": "The parts that do the jobs.", "parent": null, "crosscut": false},',
'    {"id": "stage-4", "title": "Reporting", "description": "How results leave the system.", "parent": null, "crosscut": false}',
'  ]', '}', '```'].join('\n');
const json = extractJsonBlock(reply);
const sk = normalizeSkeleton(json);
console.log('extractJsonBlock:', JSON.stringify(json));
console.log('stages          :', sk.stages.length, JSON.stringify(sk.stages.map((s) => s.id + '/' + s.title)));
console.log('guard fires?    :', sk.stages.length === 0 ? 'yes' : 'NO — run continues');
EOF
node /tmp/p4.mjs
```

```
extractJsonBlock: {"id":"stage-1","title":"Boot","description":"The wiring that runs before any work.","parent":null,"crosscut":false}
stages          : 1 ["stage-1/Boot"]
guard fires?    : NO — run continues
```

The model sent 4 stages. Before this change the reply produced 0 stages and the
run aborted loudly; now it produces a plausible-looking 1-chapter handbook. The
same `single` rule also turns an API error envelope into the spine:
`normalizeSkeleton({error: 'rate limited', id: 'req-123'})` →
`1 stage titled "req-123"`, and `normalizeSkeleton({title: 'System Handbook', overview: '…'})`
→ `1 stage titled "System Handbook"`.

Expected: `single` must require a *distinguishing* field, not `id`/`title` — the
two most generic keys in JSON. For stages, require `id` **and** (`description` or
`parent`), and additionally refuse the single-object path when the caller expects
a list of ≥2 (a 1-stage skeleton for a repo with >1 rollup directory is never a
valid answer). Note `narrate.ts` has the same shape:
`single: {fields: ['id', 'name', 'semantics']}` will turn `{"id": "req-123", …}`
into a register.

---

### 5. [medium] `classifyMembers` pins an unrecognised entry onto `batch[0]` for batches of **40**, with no warning — the `batch.length === 1` guard present in `cards.ts` and `assign.ts` is missing

`member.ts:144`:

```ts
const member = named && batchIds.has(named) ? named : entries.length === 1 ? batch[0]?.id : undefined;
```

`cards.ts:334` and `assign.ts:78` both compute `soleFile` under
`batch.length === 1`; this site does not. Default `batchSize = 40`
(`member.ts:111`).

Observed (40-member batch, reply `{"assignments":[{"member":"app.mod.does_not_exist","stage":"stage-2"}]}`; script below):

```
non-unassigned: [["app.mod.fn1","stage-2"]]
warnings      : []
```

`app.mod.fn1` — an arbitrary member the model never mentioned — is filed into
`stage-2`. The other 39 fall to `unassigned`, and because `usable` reached 1 the
new `usable === 0` diagnostic stays silent, so nothing in the log says the batch
was lost.

Expected: `entries.length === 1 && batch.length === 1` (as at the two sibling
sites), and count `usable` against the batch size before deciding not to warn.

Script:

```sh
cat > /tmp/p5.mjs <<'EOF'
import { classifyMembers } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/member.js';
import { extractJsonBlock } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
const nodes = {};
for (let i = 1; i <= 40; i += 1) nodes[`app.mod.fn${i}`] = { id: `app.mod.fn${i}`, name: `fn${i}`, qualname: `fn${i}`,
  file: 'app/mod.py', lineStart: i, lineEnd: i, signature: `def fn${i}()`, isAsync: false, isMethod: false,
  className: null, decorators: [], kind: 'internal', synthetic: false, selfAttrsRead: [], selfAttrsWritten: [],
  paramTypes: {}, returnsType: '', docstring: '', params: [], nCallees: 0, nCallers: 0 };
const graph = { version: 1, nodes, edges: [], selfAttrs: {}, metadata: { generatedAt: '', language: 'py',
  sourceRoot: '/x', scannedFiles: ['app/mod.py'], nInternalFunctions: 40, nBoundaryNodes: 0, nEdges: 0, policy: 't' } };
const skeleton = { metadata: { version: 1, draftedBy: 't' }, stages: [
  { id: 'stage-1', title: 'A', description: 'A.', parent: null, children: [], crosscut: false },
  { id: 'stage-2', title: 'B', description: 'B.', parent: null, children: [], crosscut: false }] };
const reply = '```json\n{"assignments": [{"member": "app.mod.does_not_exist", "stage": "stage-2"}]}\n```';
const client = { model: 'p', async complete() { return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 }; } };
const warnings = [];
const res = await classifyMembers(client, graph, skeleton, { logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} } });
console.log('non-unassigned:', JSON.stringify(Object.entries(res.memberStage).filter(([, s]) => s !== 'unassigned')));
console.log('warnings      :', JSON.stringify(warnings));
EOF
node /tmp/p5.mjs
```

---

### 6. [medium] An entry with no usable `purpose` produces an empty card **and** suppresses the new per-batch diagnostic **and** the tier-2/tier-3 fallbacks

The new guard tests `Object.keys(result).length === 0` — *entries accepted*, not
*content obtained*. `entryToCard` never fails: a missing/mis-keyed `purpose`
becomes `purpose: ''`. So `result` is non-empty → no warning, no
`saveRejectedReply`; and `described[d.file]` is truthy → `cards.ts:423` and
`cards.ts:431` skip both the single-file retry and the chunked fallback for that
file.

```sh
cat > /tmp/p6.mjs <<'EOF'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCards } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/cards.js';
import { WorkDir } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/workdir.js';
import { extractJsonBlock } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
const files = ['src/a.ts', 'src/b.ts'];
const repo = mkdtempSync(join(tmpdir(), 'hb-'));
mkdirSync(join(repo, 'src'), { recursive: true });
for (const f of files) writeFileSync(join(repo, f), '// x\n');
const graph = { version: 1, nodes: {}, edges: [], selfAttrs: {}, metadata: { generatedAt: '', language: 'ts',
  sourceRoot: repo, scannedFiles: files, nInternalFunctions: 0, nBoundaryNodes: 0, nEdges: 0, policy: 't' } };
// a.ts: right shape, prose under a key the reader does not know.
const reply = '```json\n' + JSON.stringify({ purposes: [
  { file: 'src/a.ts', summary: 'the real description went here', role: 'util' },
  { file: 'src/b.ts', purpose: 'A good card.', role: 'util' }] }) + '\n```';
let calls = 0;
const client = { model: 'p', async complete() { calls += 1; return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 }; } };
const warnings = [];
const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hbw-')));
const res = await generateCards({ client, graph, sourceRoot: repo, work, batchSize: 2, detail: 'deep',
  logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} } });
console.log('card src/a.ts:', JSON.stringify(res.cards['src/a.ts']));
console.log('coverage     :', JSON.stringify(res.coverage));
console.log('llm calls    :', calls);
console.log('warnings     :', JSON.stringify(warnings));
console.log('_rejected    :', existsSync(join(work.cardsDir, '_rejected')));
EOF
node /tmp/p6.mjs
```

```
card src/a.ts: {"version":1,"file":"src/a.ts","purpose":"","role":"util","lifecycle":"none","description":"","functions":[]}
coverage     : {"nFiles":2,"nDescribed":1,"missing":["src/a.ts"]}
llm calls    : 1
warnings     : ["[cards] 1 files backfilled with empty cards"]
_rejected    : false
```

One LLM call: the tier-2 retry that exists precisely for this never ran, and the
only signal is the pre-existing aggregate line. Expected: gate on
`entryToCard(...).purpose !== ''` (i.e. keep the file in `dropped` and emit the
shape diagnostic) rather than on the presence of an entry.

---

### 7. [medium] `matchLoosely`'s basename fallback silently overwrites a correct card with a hallucinated sibling's content; in a batch of 1 the reply's file identity is ignored entirely

`matchLoosely` resolves any path whose *basename* uniquely matches a batch file.
Since the loop does `result[file] = …` with no first-wins rule, a hallucinated
entry that resolves onto an already-filled file replaces it.

```sh
cat > /tmp/p7.mjs <<'EOF'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCards } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/cards.js';
import { WorkDir } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/workdir.js';
import { extractJsonBlock } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
async function run(files, purposes, batchSize) {
  const repo = mkdtempSync(join(tmpdir(), 'hb-'));
  for (const f of files) { mkdirSync(join(repo, f.split('/').slice(0, -1).join('/')), { recursive: true }); writeFileSync(join(repo, f), '// x\n'); }
  const graph = { version: 1, nodes: {}, edges: [], selfAttrs: {}, metadata: { generatedAt: '', language: 'ts',
    sourceRoot: repo, scannedFiles: files, nInternalFunctions: 0, nBoundaryNodes: 0, nEdges: 0, policy: 't' } };
  const reply = '```json\n' + JSON.stringify({ purposes }) + '\n```';
  const client = { model: 'p', async complete() { return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 }; } };
  const warnings = [];
  const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hbw-')));
  const res = await generateCards({ client, graph, sourceRoot: repo, work, batchSize,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} } });
  for (const f of files) console.log(' ', f, '->', JSON.stringify(res.cards[f].purpose));
  console.log('  coverage:', JSON.stringify(res.coverage), 'warnings:', warnings.length);
}
console.log('CASE 1 — hallucinated sibling path overwrites the correct card:');
await run(['src/a/config.ts', 'src/b/main.ts'], [
  { file: 'src/a/config.ts', purpose: 'CORRECT: loads the a-side config.', role: 'config' },
  { file: 'src/b/config.ts', purpose: 'WRONG: describes a path that is not in the batch.', role: 'util' }], 2);
console.log('CASE 2 — batch of 1 ignores the reply file identity:');
await run(['src/core/index.ts'], [
  { file: 'packages/llm/src/client.ts', purpose: 'The OpenAI chat client.', role: 'io_transport' }], 1);
EOF
node /tmp/p7.mjs
```

```
CASE 1 — hallucinated sibling path overwrites the correct card:
  src/a/config.ts -> "WRONG: describes a path that is not in the batch."
  src/b/main.ts -> ""
  coverage: {"nFiles":2,"nDescribed":1,"missing":["src/b/main.ts"]} warnings: 2
CASE 2 — batch of 1 ignores the reply file identity:
  src/core/index.ts -> "The OpenAI chat client."
  coverage: {"nFiles":1,"nDescribed":1,"missing":[]} warnings: 0
```

CASE 1: the one file reported as described carries prose written for a path that
does not exist in the repo — `src/b/config.ts` resolved onto `src/a/config.ts` via
the basename fallback and overwrote the correct entry. CASE 2 (batch of 1 — deep
mode, the tier-2 retry, and every resync) accepts a card written for a completely
unrelated file with zero warnings.

Expected: first-wins for an explicit exact match, and skip an entry whose loose
match lands on a file that already has a card from this batch. For the
`entries.length === 1 → soleFile` path, require that the named path *not* resolve
elsewhere in the graph — if the model names a real file that isn't in the batch,
that is a wrong answer, not a loose one.

---

### 8. [medium] `repairJson` returns wrong data (not `undefined`) for arrays of strings: one element is split into two and the separator characters are destroyed

Over 88 realistic reply shapes with one unescaped prose quote: 48 recovered,
36 returned `undefined`, **4 returned valid-but-different data** — all arrays of
strings.

```sh
cat > /tmp/p8.mjs <<'EOF'
import { repairJson } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
for (const intended of [{ tags: ['supports "list", "map" and "filter"'] },
                        { also: ['sets "mode" to "on", "off"', 'stage-2'] }]) {
  const wire = JSON.stringify(intended, null, 1).replace(/\\"/g, '"');
  console.log('intended:', JSON.stringify(intended));
  console.log('got     :', JSON.stringify(repairJson(wire)));
}
EOF
node /tmp/p8.mjs
```

```
intended: {"tags":["supports \"list\", \"map\" and \"filter\""]}
got     : {"tags":["supports \"list","map\" and \"filter\""]}
intended: {"also":["sets \"mode\" to \"on\", \"off\"","stage-2"]}
got     : {"also":["sets \"mode\" to \"on","off\"","stage-2"]}
```

Expected `undefined` (fail) rather than a silently different array. Blast radius
*today* is limited — the string arrays in the live schemas (`also`,
`groups[].files`, `registers[].stages`) are id/path lists that get filtered
against closed menus — but `repairJson` is exported from `@handbook/core` as a
general utility, and the docstring promises it "never guesses at structure".
Splitting one array element into two *is* guessing at structure.

---

### 9. [medium] `asList` returns a truthy empty array, so a non-object array under an earlier key short-circuits every later container key **and** the `single` fallback

```ts
const hit = asList(record[key]);
if (hit) return hit;          // [] is truthy
```

```sh
cat > /tmp/p9.mjs <<'EOF'
import { extractEntryList } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
console.log('real list under a later key is discarded:',
  JSON.stringify(extractEntryList({ registers: [], state: [{ id: 'r1' }] }, ['registers', 'state'])));
console.log('strings under the first key hide the objects under the second:',
  JSON.stringify(extractEntryList({ purposes: ['a.ts does X'], files: [{ file: 'a.ts', purpose: 'X' }] }, ['purposes', 'files'])));
console.log('nested arrays pass the object filter and become "entries":',
  JSON.stringify(extractEntryList({ groups: [['a.ts', 'b.ts']] }, ['groups'])));
EOF
node /tmp/p9.mjs
```

```
real list under a later key is discarded: []
strings under the first key hide the objects under the second: []
nested arrays pass the object filter and become "entries": [["a.ts","b.ts"]]
```

Two bugs in one helper: (a) `[]` should be `undefined` when the array held no
objects, so the remaining keys and `single` still get a chance; (b) the type
guard `typeof v === 'object' && v !== null` admits arrays, so a nested array is
handed to callers typed as `Record<string, unknown>` — in `cards.ts` that
produces an all-empty card that then triggers F6.

---

### 10. [medium] Treating `finish_reason === 'length'` as failure discards usable prose, burns all 6 retries, and sets the flag that arms F3

The stated rationale — *"its JSON will not parse and its prose stops
mid-sentence"* — only holds for the JSON call sites. The narration path
(`narrate.ts:79 cachedCall`) asks for free prose; a paragraph cut off at the cap
was previously ~95 % usable text. Now it throws, `retry` exhausts 6 attempts with
3 s linear backoff (≈45 s of sleeping) at 1×/2×/3×/4×/4× the token budget, and
`cachedCall` substitutes a canned `fallback()` — strictly worse output for more
money. It also sets `sawTruncation`, which then inflates every card/assign call
on the same client (F3).

```sh
cat > /tmp/p10.mjs <<'EOF'
import { OpenAiChatClient } from '/Users/jack/Desktop/share/handbook/packages/llm/dist/client.js';
const sent = [];
const prose = 'The Queue stage is one station on this system’s assembly line: work arrives from the previous station, this stage does its one job, and the result moves';
const client = new OpenAiChatClient({
  config: { apiKey: 'EMPTY', model: 'glm-5.2', maxTokens: 16000, maxRetries: 6, retryBackoffMs: 0 },
  fetchImpl: async (_u, init) => {
    const b = JSON.parse(init.body); sent.push(b.max_tokens);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: prose } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
try { const r = await client.complete('writing the OVERVIEW for one stage'); console.log('resolved:', r.text.slice(0, 40)); }
catch (e) { console.log('REJECTED after all retries:', String(e.message).slice(0, 95)); }
console.log('max_tokens per attempt:', JSON.stringify(sent));
EOF
node /tmp/p10.mjs
```

```
REJECTED after all retries: LLM response was truncated at the token limit (max_tokens=64000, 152 chars) — raise OPENAI_MAX_
max_tokens per attempt: [16000,32000,48000,64000,64000,64000]
```

Six requests, 152 chars of perfectly usable prose thrown away each time, and
`cachedCall` then substitutes `fallback()`. Note the budget escalation is caused
by this very call setting `sawTruncation` on attempt 1 — which is also what arms
F3 for every other call on the client.

Expected: only reject a truncated completion when the caller needs structure and
the structure is in fact broken — e.g. accept it if `extractJsonBlock(text)`
returns a usable value, and for prose callers accept the partial text (optionally
trimmed to the last sentence boundary) rather than falling back to a template.

---

### 11. [medium] The total-failure guard aborts a legitimate small-repo run on one transient failure, and its message points at diagnostics that do not exist

`if (files.length > 0 && coverage.nDescribed === 0) throw` fires whenever *no*
file is described. Traced exactly:

- **resume with all cards complete** — safe: disk cards are loaded into `cards`
  before the loop, so `nDescribed === files.length`. Does not fire.
- **`onlyFiles` resync with out-of-scope cards present** — safe: out-of-scope
  cards are kept (`cards.ts:300`) and counted. Does not fire.
- **1-file (or very small) repo, one flaky failure** — fires, killing the run.
  A 2-file repo with the same failure rate proceeds at 50 % coverage; there is no
  `--allow-partial` escape.
- **`onlyFiles` scope that resolves to no in-graph file, on a work dir with no
  cards** — fires after **zero** LLM calls, blaming `OPENAI_MODEL`/`OPENAI_BASE_URL`.
  (Not reachable from `resync.ts`, which derives targets from the new graph, but
  reachable through the exported API.)

Proof script (three cases; `mk()` builds a repo + graph exactly as in `/tmp/p6.mjs`):

```sh
cat > /tmp/p11.mjs <<'EOF'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCards } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/cards.js';
import { WorkDir } from '/Users/jack/Desktop/share/handbook/packages/pipeline/dist/workdir.js';
import { extractJsonBlock } from '/Users/jack/Desktop/share/handbook/packages/core/dist/index.js';
function mk(files) {
  const repo = mkdtempSync(join(tmpdir(), 'hb-'));
  for (const f of files) { mkdirSync(join(repo, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true }); writeFileSync(join(repo, f), '// x\n'); }
  return { repo, graph: { version: 1, nodes: {}, edges: [], selfAttrs: {}, metadata: { generatedAt: '', language: 'ts',
    sourceRoot: repo, scannedFiles: files, nInternalFunctions: 0, nBoundaryNodes: 0, nEdges: 0, policy: 't' } } };
}
async function go(label, files, client, extra) {
  const { repo, graph } = mk(files);
  const warnings = []; let calls = 0;
  const wrapped = { model: 'p', complete: (...a) => { calls += 1; return client.complete(...a); } };
  const work = new WorkDir(mkdtempSync(join(tmpdir(), 'hbw-')));
  console.log('###', label);
  try { await generateCards({ client: wrapped, graph, sourceRoot: repo, work, batchSize: 1, ...extra,
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} } }); console.log('  resolved'); }
  catch (e) { console.log('  THREW:', String(e.message).slice(0, 100) + '…'); }
  console.log('  warnings :', JSON.stringify(warnings));
  console.log('  _rejected:', existsSync(join(work.cardsDir, '_rejected')) ? readdirSync(join(work.cardsDir, '_rejected')) : '(absent)');
  console.log('  llm calls:', calls);
}
await go('1-file repo, one transient failure', ['src/only.ts'],
  { async complete() { throw new Error('LLM returned empty content (finish_reason=stop)'); } }, {});
const r = '```json\n' + JSON.stringify({ purposes: [{ file: 'src/only.ts', summary: 'prose under an unknown key', role: 'util' }] }) + '\n```';
await go('1-file repo, F6 path (entry with no usable purpose)', ['src/only.ts'],
  { async complete() { return { text: r, json: extractJsonBlock(r), elapsedSec: 0 }; } }, {});
await go('onlyFiles scope matching nothing, empty work dir', ['src/a.ts', 'src/b.ts'],
  { async complete() { return { text: '{}', json: {}, elapsedSec: 0 }; } }, { onlyFiles: ['src/removed.ts'] });
EOF
node /tmp/p11.mjs
```

```sh
### 1-file repo, one transient failure
  THREW: [cards] all 1 files failed to be described — the model returned nothing usable. Check OPENAI_MODEL/O…
  warnings : ["[cards] batch of 1 failed: Error: LLM returned empty content (finish_reason=stop)","[cards] 1 files backfilled with empty cards"]
  _rejected: (absent)
  llm calls: 1
### 1-file repo, F6 path (entry with no usable purpose)
  THREW: [cards] all 1 files failed to be described — the model returned nothing usable. Check OPENAI_MODEL/O…
  warnings : ["[cards] 1 files backfilled with empty cards"]
  _rejected: (absent)
  llm calls: 1
### onlyFiles scope matching nothing, empty work dir
  THREW: [cards] all 2 files failed to be described — the model returned nothing usable. Check OPENAI_MODEL/O…
  warnings : ["[cards] 2 files backfilled with empty cards"]
  _rejected: (absent)
  llm calls: 0
```

The second case is the worst: the message says *"check the warnings above"* and
*"the model returned nothing usable"*, but F6 means there is no shape warning and
no `_rejected` reply to read — the abort is undiagnosable, which is the opposite
of this commit's purpose.

Expected: gate on a ratio with a floor (e.g. `nDescribed === 0 && files.length >= 3`),
require `todo.length > 0` (never blame the model when it was not called), and
make the message enumerate what *was* captured (`_rejected` file count, distinct
failure reasons).

---

### 12. [low] `var(--warn,#d08a2a)` — `--warn` is defined nowhere, so the described-coverage line hard-codes an amber that fails contrast in the light theme

`index.html:1144` is the only occurrence of `--warn` in the repo, so the fallback
always wins. Every other colour in this file is theme-paired
(`--red: #E0705C` dark / `#A03720` light).

```sh
node -e '
const lum=(h)=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4));return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
const cr=(a,b)=>{const l1=lum(a),l2=lum(b);return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)).toFixed(2);};
console.log("#d08a2a on light panel #F1EADB :", cr("#d08a2a","#F1EADB"));
console.log("#d08a2a on dark  panel #10151A :", cr("#d08a2a","#10151A"));
console.log("--red (light) #A03720 on #F1EADB:", cr("#A03720","#F1EADB"));'
```

```
#d08a2a on light panel #F1EADB : 2.39
#d08a2a on dark  panel #10151A : 6.42
--red (light) #A03720 on #F1EADB: 5.73
```

2.39:1 is below WCAG AA (4.5:1) — the new warning line is the least readable text
on the light-theme overview, which is exactly backwards for a warning. Expected:
add `--warn` to both `:root[data-theme="dark"]` and `:root[data-theme="light"]`
blocks (e.g. `#D8A24A` / `#8A5A10`) and drop the literal.

No crash risk in this change: `ov.cardCoverage || null` handles a missing field,
`cc.missing && cc.missing.length` handles a missing array, and `cc.nFiles === 0`
yields `dPct === null` which only skips the colour. Numbers are concatenated
without `esc()` but come from a zod-validated `z.number().int()`.

---

### 13. [low] `/overview` now 409s a fully generated handbook if `cards/_coverage.json` is unreadable

`work.loadCardCoverage()` (`server.ts:487`) uses `readValidatedJson` and throws
`ArtifactValidationError` on a malformed file; the route's catch answers
`409 {"error": "handbook not generated yet: …"}` and the UI renders the
"not generated" empty state. The neighbouring optional artifact is guarded
(`fileExists(work.narrationPath) ? work.loadNarration() : undefined`); the new
one is not.

```
loadCardCoverage on {"nFiles":3,"nDescribed":3}  ->
THREW: ArtifactValidationError - invalid artifact …/phase2/cards/_coverage.json: missing: Invalid input: expected a…
```

The schema has never changed (`git log -S cardCoverageSchema` → one commit), so
this needs a truncated/hand-edited file rather than a version skew — hence low.
Expected: wrap it, `cardCoverage: (() => { try { return work.loadCardCoverage() ?? null } catch { return null } })()`.

---

### 14. [low] `_rejected/` is never cleaned between runs, and non-ASCII paths collide onto one filename

Verified: no path escape (`../../../../tmp/pwned` → `.._.._.._.._tmp_pwned.txt`,
nothing written outside the work root) and `loadCards()` is unaffected
(`listFilesRecursive(..., {extensions: ['.json']})` skips the `.txt` files).

But: `中文/文件.ts` → `_.ts.txt`, so every CJK-named file's rejected reply
overwrites the same file; nothing removes stale replies, so a later run's
diagnosis reads replies from an earlier run with no timestamp to tell them apart;
and at `batchSize: 1` over a large repo the directory can reach one full reply per
file.

```
files written under cards/_rejected:
   "...txt"  ".._.._.._.._.._.._tmp_pwned.txt"  "..txt"  "_.ts.txt"  "_etc_passwd.txt"
   "aaaa…(120 chars).txt"  "src_a.ts.txt"
anything outside the work root? false
loadCards() -> {}
after a second WorkDir over the same root, stale replies survive: 7 files
```

Expected: clear `_rejected/` at the start of a cards pass, and disambiguate with
a short hash of the full path instead of collapsing to `_`.

---

## Non-findings (hypotheses disproved)

- `repairJson('{"a": "", "b": 1}')` → `{"a":"","b":1}`: a legitimately empty string value is fine (the closing quote sees `,`).
- `repairJson('{"a": "C:\\\\", "b": 1}')` → `{"a":"C:\\","b":1}`: a string ending in an escaped backslash is handled; the `escaped` flag correctly consumes the second backslash.
- `repairJson('{"a": "he said: \\"", "b": 1}')` → correct: an escaped quote immediately before a structural char is preserved.
- Unicode escapes survive: `{"a": "\u4e2d "x" \u6587"}` → `{"a":"中 \"x\" 文"}`.
- `'{"key": "a" "b"}'` → `{"key":"a\" \"b"}`: a debatable merge, but the input is malformed either way and no field is lost.
- The intended CJK case works: `{"purpose": "解析 "配置" 文件", "role": "core"}` → correct.
- `extractJsonBlock` ordering for a *repairable* fence is right: the repaired fence beats the balanced-scan fragment (verified with a fenced deep reply whose quote pattern `"…" of` is repairable).
- `balancedSpans` returns the outermost span first (it iterates start indices ascending), so the last-resort repair pass does not prefer an inner fragment.
- `saveRejectedReply` cannot escape the cards directory: `/`, `..`-only and absolute names all sanitise to a leaf filename.
- `saveRejectedReply` does not break `loadCards()` and does not leak into any published output (`_rejected` lives in `<work>/phase2/cards/`, not in the handbook/skill output dirs).
- The empty-content check does not affect `MockChatClient` (it never calls `request()`), so existing tests and offline pipelines are unaffected.
- The empty-content and truncation checks do not break `examples/mock-llm-server.mjs`: it omits `finish_reason` (→ `'unknown'`) and always returns non-empty content.
- `looksLikeGatewayPage` is not fooled by a JSON error body starting with whitespace; `trimStart()` handles the leading-newline case.
- `organize.ts` remains safe under the looser reader: files are validated against `inStage`, empty groups are dropped, and unplaced files land in an "Other" group, so a junk group cannot lose a file.
- `resume` with every card already complete does **not** trip the total-failure guard (disk cards are counted in `nDescribed`).
- `onlyFiles` resync with existing out-of-scope cards does **not** trip the guard.
- `assign.ts` and `cards.ts` do guard the single-entry attribution with `batch.length === 1` (only `member.ts` does not — F5).
- The studio `cardCoverage` rendering cannot throw on a missing/partial field (`|| null`, `cc.missing &&`, `cc.nFiles` truthiness all guarded).
- `git log -S cardCoverageSchema` shows one commit: there is no legacy `_coverage.json` shape to break on.
- Full suite green after the change: `npx vitest run` → 24 files / 260 tests.

/**
 * The agent artifact (deterministic, no LLM).
 *
 * Writes a small always-read `index.md`, three grep-target fact tables
 * (`symbols.tsv`, `files.tsv`, `calls.tsv`) and one short `stages/<sid>.md` per
 * content-bearing stage.
 *
 * This replaced a design that rendered the SAME prose as the human handbook
 * into a different shape — which is how the agent artifact came to be 2.1x the
 * size of the human one while containing no symbol locations at all. The rule
 * now: the human artifact explains, and this one locates. Where an agent needs
 * the explanation it is one hop away, in the human page, rather than copied.
 *
 * Facts and prose are never mixed in a column. Prose appears in exactly one
 * place — the last column of a file row — clipped, and labelled `[prose]`.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, truncate, writeFileAtomic } from '@handbook/core';
import type { HandbookModel } from '@handbook/core';
import { UNASSIGNED, assignedFiles, callsTsv, filesTsv, symbolRows, symbolsTsv } from './agent-facts.js';
import type { SymbolRow } from './agent-facts.js';
import { HandbookView, genericTierLanguages, typeIndexCoverage, fileDir, fileStem } from './shared.js';
import type { FidelityOptions } from './shared.js';

/**
 * Test twins of `rel` — the file whose NAME marks it as the tests for this one.
 *
 * Every shipped language has its own convention, and missing one makes the whole
 * field silently render nowhere: `<stem>.test.*` / `<stem>.spec.*` is how TS/JS
 * name tests, so a TypeScript repo used to produce zero co-change lines while
 * sitting next to its own tests. Covered: `<stem>_test(s).*` (Go, Python, Shell),
 * `test_<stem>.*` (Python), `<stem>.test.*` / `<stem>.tests.*` / `<stem>.spec.*`
 * (TS/JS), `<stem>_spec.*` (spec-style suites). Looked for beside the file and in
 * a sibling `__tests__/` directory.
 */
export function strongTwins(rel: string, allFiles: readonly string[]): string[] {
  const stem = escapeRegExp(fileStem(rel));
  const patterns = [
    new RegExp(`^${stem}_tests?\\.[^.]+$`),
    new RegExp(`^${stem}_spec\\.[^.]+$`),
    new RegExp(`^test_${stem}\\.[^.]+$`),
    new RegExp(`^${stem}\\.(?:tests?|spec)\\.[^.]+$`),
  ];
  const dir = fileDir(rel);
  const twinDirs = new Set([dir, dir === '' ? '__tests__' : `${dir}/__tests__`]);
  return allFiles.filter(
    (f) => f !== rel && twinDirs.has(fileDir(f)) && patterns.some((p) => p.test(f.split('/').pop() ?? f)),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The stage table's `path prefixes` column: the directories a stage's files
 * actually live in, most-populated first.
 *
 * This replaces the old "entry concepts" list, which emitted bare file stems
 * (`registry`, `names`). Half of those matched more than one file in the
 * repository and a tenth were `.test` leftovers from stripping a single
 * extension — but the deeper problem was that a stem is not something an agent
 * can act on. A path prefix is greppable, globbable, and can be wired straight
 * into a rules file's `paths:` field.
 */
function pathPrefixes(files: readonly string[], max = 2): string[] {
  const byDir = new Map<string, number>();
  for (const file of files) {
    const dir = fileDir(file);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  return [...byDir.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([dir]) => (dir === '' ? './' : `${dir}/`));
}

/** Files routed to `sid`, from the authoritative assignment. */
function stageFiles(model: HandbookModel, sid: string): string[] {
  return assignedFiles(model)
    .filter((r) => r.stage === sid)
    .map((r) => r.file);
}

/**
 * The always-read entry file.
 *
 * Hard budget: this is paid on every session AND on every subagent spawn, so it
 * is the one file whose size is a product decision rather than a consequence.
 * It carries routing and nothing else — no per-file descriptions, which is
 * exactly the content Anthropic's own guidance names as the thing that must not
 * be always-loaded.
 */
function agentIndexMd(view: HandbookView, symbols: readonly SymbolRow[], options: FidelityOptions): string {
  const generic = genericTierLanguages(options.languages);
  const types = typeIndexCoverage(options.languages);
  const { model } = view;
  const files = assignedFiles(model);
  const routed = files.filter((f) => f.stage !== UNASSIGNED);
  const withSymbols = new Set(symbols.map((s) => s.file));
  const stages = view.contentStages();
  const provenance = model.provenance;
  const stamp = [
    provenance?.generatedAt ? `generated ${provenance.generatedAt}` : 'generated (timestamp unavailable)',
    provenance?.commit ? `from ${provenance.commit}` : undefined,
    `${files.length} files`,
    `${symbols.length} symbols`,
    `${stages.length} stages`,
  ]
    .filter(Boolean)
    .join(' | ');

  const out: string[] = [
    `# ${model.title} — agent index`,
    '',
    stamp,
    'facts below are parser-derived. model-written prose is marked [prose] wherever it appears.',
    '',
    '## lookup',
    '',
    '```',
    'symbol -> location     grep -m5 "^NAME\t" symbols.tsv',
    'file   -> its symbols  grep "\tPATH:" symbols.tsv',
    'callers of a symbol    grep "\tNAME\t" calls.tsv',
    'callees of a symbol    grep "^NAME\t" calls.tsv',
    'file   -> stage, role  grep "^PATH\t" files.tsv',
    'stage  -> its files    read stages/<sid>.md',
    '```',
    '',
    'Then open the file and read the line range. This index can be stale; the code cannot.',
    '',
    '## stages',
    '',
    '```',
    'sid\tfiles\tsymbols\tpath prefixes',
  ];

  for (const sid of stages) {
    const own = stageFiles(model, sid);
    const nSymbols = symbols.filter((s) => s.stage === sid).length;
    out.push([sid, String(own.length), String(nSymbols), pathPrefixes(own).join(' ')].join('\t'));
  }
  out.push('```', '');

  const registers = model.registers ?? [];
  if (registers.length > 0) {
    out.push('## state registers', '', '```');
    for (const reg of registers) {
      const touching = stages.filter((sid) => view.directRegisters(sid).some((r) => r.id === reg.id));
      out.push([reg.id, touching.join(',') || '—'].join('\t'));
    }
    out.push('```', '');
  }

  // Coverage. Invariant 1's "never drop" applies to this artifact too: an index
  // that silently omits a quarter of the files reads as "those files are empty".
  const noSymbols = files.filter((f) => !withSymbols.has(f.file)).length;
  out.push('## coverage', '');
  out.push(
    `${routed.length}/${files.length} files routed to a stage; ${files.length - routed.length} unrouted (stage=${UNASSIGNED} in files.tsv).`,
  );
  out.push(
    `${noSymbols} of ${files.length} files contribute no symbol row: the parser found no functions in them.`,
  );
  const nTypes = symbols.filter((s) => s.kind.startsWith('type:')).length;
  const nDerived = symbols.filter((s) => s.kind === 'class-derived').length;
  out.push(
    `symbols.tsv indexes functions and methods (${symbols.length - nTypes - nDerived}) plus ${nTypes} parsed type declaration(s) and ${nDerived} class row(s) whose span was derived from members.`,
  );
  // Invariant 3, applied to types. A parsed row and an absent one are
  // indistinguishable from outside, so which languages were actually looked at is
  // the only thing that lets a reader tell a real miss from an unindexed one.
  if (types.indexed.length > 0) {
    out.push(`Types indexed (kind=type:… rows) for: ${types.indexed.join(', ')}.`);
  }
  if (types.notIndexed.length > 0) {
    out.push(
      `Types are NOT indexed for: ${types.notIndexed.join(', ')} — a miss there is not proof the name does not exist. A class in one of those still appears as kind=class-derived, located by its methods.`,
    );
  }
  if (types.undeclared.length > 0) {
    out.push(
      `Type coverage is unknown for: ${types.undeclared.join(', ')} — that adapter declared none either way, so treat a miss as unproven.`,
    );
  }
  if (types.indexed.length === 0 && types.notIndexed.length === 0 && types.undeclared.length === 0) {
    // No fidelity information reached the renderer at all (a pre-declaration work
    // dir, or a caller that passed no options). Saying nothing would let the row
    // counts above imply full coverage.
    out.push(
      'Which languages had their types indexed is unknown for this run: no fidelity declaration was recorded, so a missing type row is not proof the name does not exist.',
    );
  }
  // Constants and variables are indexed by NO adapter, in any language — a flat
  // statement, not a per-language one.
  out.push('Constants, variables and macros are not indexed in any language.');
  if (generic.length > 0) {
    out.push(
      `Call relations for ${generic.join(', ')} come from a generic-tier adapter: names and files are reliable, edges are best-effort.`,
    );
  }
  out.push('');
  return out.join('\n');
}

/**
 * A stage page: the second hop, and the last one.
 *
 * What used to be here — a duty paragraph, entry concepts, related groups, core
 * files, and a full prose block per function — produced a 313 KB page for the
 * largest stage. No agent reads that; it greps it, and gets back fragments of
 * facts that were split across non-adjacent lines. The per-symbol detail now
 * lives in `symbols.tsv`, indexed by the key an agent actually holds (a name)
 * rather than the key it is trying to discover (a stage).
 */
function agentStagePageMd(view: HandbookView, sid: string, symbols: readonly SymbolRow[]): string {
  const { model } = view;
  const own = stageFiles(model, sid);
  const mine = symbols.filter((s) => s.stage === sid);
  const registers = view.directRegisters(sid).map((r) => r.id);
  const allFiles = assignedFiles(model).map((r) => r.file);

  const out: string[] = [
    `# ${sid}`,
    '',
    [
      `${own.length} files`,
      `${mine.length} symbols`,
      registers.length > 0 ? `registers: ${registers.join(' ')}` : undefined,
    ]
      .filter(Boolean)
      .join(' | '),
    '',
    `symbols in this stage: grep "\t${sid}\t" ../symbols.tsv`,
    // The paragraph lives in the human handbook. Pointing there rather than
    // duplicating it is the whole reason the two artifacts stopped being the
    // same bytes.
    `prose (model-written): ../${sid}.md`,
    '',
    '## files (path, role, symbols, purpose[prose])',
    '',
    '```',
  ];
  for (const file of own) {
    const card = model.cards[file];
    out.push(
      [
        file,
        card?.role ?? 'other',
        String(card?.functions?.length ?? 0),
        truncate((card?.purpose ?? '').replace(/\s+/g, ' ').trim(), 120),
      ].join('\t'),
    );
  }
  out.push('```', '');

  // Kept from the old locator block, and the only thing kept: it is purely
  // structural, it is not reproducible by grep, and it answers the question an
  // agent asks immediately after "where is X" — namely "what else must I touch".
  const twins: string[] = [];
  for (const file of own) {
    for (const twin of strongTwins(file, allFiles)) twins.push(`${file}\t${twin}`);
  }
  if (twins.length > 0) {
    out.push('## co-change (source ↔ its test)', '', '```', ...twins, '```', '');
  }
  return out.join('\n');
}

/**
 * Render the agent artifact into `outDir`.
 *
 * Returns the number of stage pages and the number of symbol rows — the second
 * replaces a collision count that indexed stage-title tokens, a signal the
 * symbol table now provides for free and far more precisely.
 */
/**
 * The agent artifact's entry file — the one a consumer probes to decide whether
 * the artifact is there at all.
 *
 * Exported so no caller has to name it. Studio hardcoded `how_to_use.md` here;
 * when the artifact was redesigned that file stopped existing, the probe went
 * permanently false, and every skill studio built silently shipped without its
 * agent index. An absent artifact is a supported configuration, so nothing
 * errored. A shared constant makes that drift impossible rather than merely
 * unlikely.
 */
export const AGENT_INDEX_FILE = 'index.md';

export function renderAgentSite(
  model: HandbookModel,
  outDir: string,
  options: FidelityOptions = {},
): { nStagePages: number; nSymbols: number } {
  const view = new HandbookView(model);
  ensureDir(outDir);
  const stagesDir = join(outDir, 'stages');
  ensureDir(stagesDir);

  // The agent dir is fully renderer-owned, so it is emptied COMPLETELY rather
  // than by extension. Deleting only the extensions this version happens to
  // write leaves behind whatever a different version wrote, and the result is a
  // directory holding two generations at once — an agent then finds a protocol
  // page describing files that are not there beside an index describing files
  // it was never told about. Observed for real: a `handbook studio` process
  // still running an older build re-rendered over a newer artifact, and because
  // that build's cleanup only knew about `.md`, the newer `.tsv` tables
  // survived alongside it.
  //
  // Nothing an agent needs is authored here — corrections live in the skill
  // package — so emptying it loses nothing.
  for (const stale of readdirSync(outDir)) rmSync(join(outDir, stale), { recursive: true, force: true });
  ensureDir(stagesDir);

  const symbols = symbolRows(view);
  const contentStages = view.contentStages();
  for (const sid of contentStages) {
    writeFileAtomic(join(stagesDir, `${sid}.md`), agentStagePageMd(view, sid, symbols));
  }
  writeFileAtomic(join(outDir, 'symbols.tsv'), symbolsTsv(view));
  writeFileAtomic(join(outDir, 'files.tsv'), filesTsv(view));
  writeFileAtomic(join(outDir, 'calls.tsv'), callsTsv(view));
  writeFileAtomic(join(outDir, AGENT_INDEX_FILE), agentIndexMd(view, symbols, options));

  return { nStagePages: contentStages.length, nSymbols: symbols.length };
}

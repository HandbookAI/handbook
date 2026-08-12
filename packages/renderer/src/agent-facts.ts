/**
 * The agent artifact's fact tables.
 *
 * These are the files an agent greps. Everything here is derived from the
 * parser — `HandbookModel`'s structural half — and nothing in a fact column is
 * model-written. The one prose column is last, is clipped, and is labelled.
 *
 * TSV rather than a markdown table, for three measured reasons:
 *
 *   1. A signature is not table-safe. 338 symbol rows in this repo contain `|`
 *      (TypeScript union types), which a markdown table would mangle and an
 *      agent would then mis-parse — silently, as a shorter signature.
 *   2. One fact per line survives truncation. An agent that greps gets whole
 *      facts back; a markdown table's header, alignment row and body are three
 *      non-adjacent lines that only mean something together.
 *   3. A tab is an anchor. `grep "\tNAME\t"` matches a whole column, where
 *      `grep NAME` matches any substring of any column.
 *
 * Column order is VALUE order — the thing you looked up first, the prose last —
 * because consumers clip long lines (this repo's own planner clips grep output
 * at 200 chars), and clipping must eat prose before it eats a path.
 *
 * Every byte is a pure function of the model: sorts are explicit and byte-wise,
 * never locale-aware, so an unchanged model re-renders identically.
 */
import { truncate } from '@handbooks/core';
import type { FileCard, FunctionNote, HandbookModel, TypeKind } from '@handbooks/core';
import type { FidelityOptions, HandbookView } from './shared.js';

/** Stage id used for a file the assignment pass could not route. */
export const UNASSIGNED = 'unassigned';

/** Longest prose kept in a fact table's last column. */
const PURPOSE_CHARS = 120;

/**
 * Byte-wise compare, so ordering never depends on the machine's locale.
 * `localeCompare` puts `_coverage` before `analyzer` in one locale and after it
 * in another, which would make a rendered artifact differ between developers.
 */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A tab or a newline inside a cell would forge a column. Neither can appear in real data, so this is a guard, not a transform. */
function cell(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').trim();
}

/** One prose sentence, clipped, for the last column only. */
function purposeCell(card: FileCard | undefined): string {
  return cell(truncate((card?.purpose ?? '').trim(), PURPOSE_CHARS));
}

/**
 * Every file the assignment pass knows about, with its stage.
 *
 * Keyed on `assignment.fileStage` and NOT on `model.cards`: the two disagree.
 * A card is written per file and never evicted, so a file deleted between runs
 * keeps its card — this repo's own work dir carries 169 cards for 167 files,
 * the extras being paths that no longer exist. A fact table whose entire
 * promise is "this path exists" must not be keyed on the list that outlives
 * deletion.
 */
export function assignedFiles(model: HandbookModel): Array<{ file: string; stage: string }> {
  const rows = Object.entries(model.assignment.fileStage).map(([file, entry]) => ({
    file,
    stage: entry.stage || UNASSIGNED,
  }));
  rows.sort((a, b) => byBytes(a.file, b.file));
  return rows;
}

/** node id → where that function lives, for resolving call edges to a location. */
export function locationIndex(model: HandbookModel): Map<string, { file: string; line: number }> {
  const byId = new Map<string, { file: string; line: number }>();
  for (const [file, card] of Object.entries(model.cards)) {
    for (const fn of card.functions ?? []) byId.set(fn.id, { file, line: fn.lineRange[0] });
  }
  return byId;
}

/**
 * What a symbol row's `kind` column can say.
 *
 * Three shapes, distinguishable at a glance and never confusable:
 *
 *   - `fn` — a parsed function or method.
 *   - `type:<kind>` — a parsed type DECLARATION, with its {@link TypeKind}. The
 *     prefix means one grep (`grep -P "\ttype:"`) finds every type and a narrower
 *     one (`grep "\ttype:interface\t"`) finds every interface, without `other`
 *     sitting bare in a column beside `fn` where it would look like a third
 *     function flavour.
 *   - `class-derived` — the interim: a class whose span was inferred from where
 *     its METHODS are, because the adapter that analyzed its language does not
 *     extract types. Kept, and kept visibly different from `type:class`.
 */
export type SymbolKind = 'fn' | 'class-derived' | `type:${TypeKind}`;

/** A symbol row, before it is a line of text. */
export interface SymbolRow {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  kind: SymbolKind;
  stage: string;
  /**
   * Resolved callers, or null when the number would not mean anything.
   *
   * Null for every row that is not a function: a type has no callers, and
   * `new Engine()` resolves to `Engine.constructor` — a function — so a type's
   * true caller count is not something the call graph holds. Printing `0` there
   * would put "nothing uses this" in the column an agent uses to judge blast
   * radius, which is the same wrong-pointer bug that made a cross-package callee
   * read as dead code before `calls.tsv` grew its boundary rows.
   */
  nCalledBy: number | null;
  signature: string;
}

/**
 * Every function and method, every parsed type, and a derived row per class the
 * parser did not reach.
 *
 * Two sources, and the difference between them is the point:
 *
 *   - `card.types` are PARSED type declarations — name, kind and a span read off
 *     the declaration node — emitted as `type:<kind>`. They come from the
 *     adapters that extract types (TypeScript, Python, Go, Rust, Java, C#).
 *   - `class-derived` is the interim for the languages that do not: the span is
 *     `min..max` of the class's METHODS, so it locates where the members are and
 *     not where the declaration is. Emitting that unmarked would put an invented
 *     line number in the column an agent trusts most; dropping it would make a
 *     class in a Ruby or Kotlin file unfindable. So: emit, and label it.
 *
 * A derived row is suppressed when a parsed row already covers the same
 * `(file, name)` — otherwise a TypeScript class would appear twice, once with its
 * real span and once with a worse one, and the reader would have no way to know
 * which to trust. Suppression is keyed on the pair rather than the name alone
 * because the same class name in two files is two different types.
 */
export function symbolRows(view: HandbookView): SymbolRow[] {
  const { model } = view;
  const stageOf = new Map(assignedFiles(model).map((r) => [r.file, r.stage]));
  // Callers that reach a symbol through an import the analyzer did not follow.
  // `nCalledBy` counts only edges inside the scanned set, so in a monorepo an
  // exported function called exclusively from other packages reads as 0 — i.e.
  // as dead code. Counting these separately keeps the column honest without
  // inflating a parser fact with a guess: they are added, and the header says
  // the number includes them.
  const boundaryCallers = new Map<string, number>();
  for (const card of Object.values(model.cards)) {
    for (const fn of card.functions ?? []) {
      for (const ext of fn.extCalls) {
        const split = ext.lastIndexOf('::');
        if (split < 0) continue;
        const name = ext.slice(split + 2);
        if (name !== '') boundaryCallers.set(name, (boundaryCallers.get(name) ?? 0) + 1);
      }
    }
  }
  const rows: SymbolRow[] = [];
  const classes = new Map<string, { file: string; start: number; end: number; n: number }>();
  /** `<file>\0<name>` covered by a PARSED type row, so no derived row is added. */
  const parsed = new Set<string>();

  for (const { file } of assignedFiles(model)) {
    const card = model.cards[file];
    const stage = stageOf.get(file) ?? UNASSIGNED;
    for (const type of card?.types ?? []) {
      // Keyed exactly like the `classes` map below, NUL-joined, so the suppression
      // compares like with like. NUL cannot occur in a path or an identifier.
      parsed.add(`${file} ${type.name}`);
      rows.push({
        name: type.name,
        file,
        startLine: type.lineRange[0],
        endLine: type.lineRange[1],
        kind: `type:${type.kind}`,
        stage,
        nCalledBy: null,
        signature: cell(type.signature),
      });
    }
    for (const fn of card?.functions ?? []) {
      rows.push({
        name: fn.name,
        file,
        startLine: fn.lineRange[0],
        endLine: fn.lineRange[1],
        kind: 'fn',
        stage,
        nCalledBy: fn.nCalledBy + (boundaryCallers.get(fn.name) ?? 0),
        signature: cell(fn.signature),
      });
      if (!fn.className) continue;
      const key = `${file} ${fn.className}`;
      const seen = classes.get(key);
      if (seen) {
        seen.start = Math.min(seen.start, fn.lineRange[0]);
        seen.end = Math.max(seen.end, fn.lineRange[1]);
        seen.n += 1;
      } else {
        classes.set(key, { file, start: fn.lineRange[0], end: fn.lineRange[1], n: 1 });
      }
    }
  }

  for (const [key, span] of classes) {
    // A parsed declaration wins: it is the same class, located properly. Emitting both
    // would put two different spans on one name with nothing to choose between them.
    if (parsed.has(key)) continue;
    const className = key.slice(key.indexOf(' ') + 1);
    rows.push({
      name: className,
      file: span.file,
      startLine: span.start,
      endLine: span.end,
      kind: 'class-derived',
      stage: stageOf.get(span.file) ?? UNASSIGNED,
      nCalledBy: null,
      signature: `${span.n} method(s) — span derived from members, not from a parsed declaration`,
    });
  }

  rows.sort((a, b) => byBytes(a.name, b.name) || byBytes(a.file, b.file) || a.startLine - b.startLine);
  return rows;
}

/**
 * `nCalledBy` as a cell: a number, or `-` where the column does not apply.
 *
 * `-` rather than `0` or an empty cell. Empty reads as a missing value in a numeric
 * column, which invites a consumer to treat it as zero; `0` IS a claim, and the
 * wrong one.
 */
function callerCell(nCalledBy: number | null): string {
  return nCalledBy === null ? '-' : String(nCalledBy);
}

export function symbolsTsv(view: HandbookView): string {
  const rows = symbolRows(view);
  const lines = [
    '# name\tlocation\tkind\tstage\tnCalledBy\tsignature',
    '# parser facts. kind=fn is a function or method. kind=type:<class|interface|struct|record|enum|',
    '# trait|alias|other> is a parsed type DECLARATION, span read off the declaration itself.',
    "# kind=class-derived is the fallback where a language's adapter extracts no types: the SPAN is",
    "# min..max of the class's METHODS, not of the declaration. Which languages are indexed and which",
    '# fall back is stated in index.md under "coverage" — a miss here is not proof a name does not exist.',
    '# nCalledBy counts callers inside the scanned set PLUS callers that reach it through an import',
    '# (see calls.tsv boundary rows); a cross-package-only callee would otherwise read as dead code.',
    '# It is `-` on a non-function row: a type has no callers, and `new T()` counts on T.constructor.',
    ...rows.map((r) =>
      [
        r.name,
        `${r.file}:${r.startLine}-${r.endLine}`,
        r.kind,
        r.stage,
        callerCell(r.nCalledBy),
        r.signature,
      ].join('\t'),
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function filesTsv(view: HandbookView, fidelity: FidelityOptions = {}): string {
  const { model } = view;
  const byFile = fidelity.fileLanguages;
  // Invariant 3 says fidelity is declared per adapter AND disclosed in the
  // output. It was disclosed globally — "call relations for Kotlin are
  // best-effort" — which a reader of a 180-row table cannot connect to a row.
  // The column appears only when the graph actually recorded who scanned what;
  // a `?` in every cell would be worse than no column.
  const tiered = byFile !== undefined;
  const tierOf = (file: string): string => {
    const language = byFile?.[file];
    if (!language) return '?';
    const tier = fidelity.languages?.[language]?.tier;
    // The language is worth printing even when its capabilities were not
    // recorded: it is still the answer to "which adapter read this file".
    return tier ? `${language}/${tier}` : language;
  };
  const lines = [
    tiered
      ? '# path\tstage\trole\tnSymbols\tlanguage/tier\tpurpose[prose]'
      : '# path\tstage\trole\tnSymbols\tpurpose[prose]',
    '# the last column is MODEL-WRITTEN and may be wrong; every other column is a parser fact.',
    ...(tiered
      ? [
          '# language/tier names the adapter that read the file. tier=generic means the call',
          '# relations on that row came from a pattern-matching engine, not a precise parse:',
          '# names and paths are reliable, edges are leads. `?` means the graph did not record it.',
        ]
      : []),
    ...assignedFiles(model).map(({ file, stage }) => {
      const card = model.cards[file];
      const cells = [file, stage, card?.role ?? 'other', String(card?.functions?.length ?? 0)];
      if (tiered) cells.push(tierOf(file));
      cells.push(purposeCell(card));
      return cells.join('\t');
    }),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Resolved call edges, both endpoints located.
 *
 * This is the file grep on source cannot replace. A text search for `scan(`
 * finds every function named `scan` in the repository — 13 of them here — while
 * these edges are RESOLVED. And per invariant 2, an edge the analyzer could not
 * resolve is not in this file at all: it is in `dropped-calls.json`. A reader
 * has to be told that, or absence here reads as "nothing calls it".
 *
 * Two kinds of row, distinguishable at a glance and never confusable:
 *
 *   - the callee's location is `path:line` — the analyzer resolved it;
 *   - the callee's location is `boundary:<specifier>` — the call leaves the
 *     scanned set through an import, and the specifier is all that is known.
 *
 * The second kind exists because this repository is a monorepo, and it turns
 * out that in one, the edges an agent most wants are exactly the ones that
 * cross a package. `checkLanguage` is called four times from `lang-guard.ts`
 * via `@handbooks/core`, and with resolved edges only it appeared with zero
 * callers — which reads as dead code. That is a wrong pointer, not a gap, and a
 * wrong pointer is the failure this whole artifact is built to avoid. A
 * `boundary:` prefix cannot be mistaken for a path, so nothing is invented.
 */
export function callsTsv(view: HandbookView): string {
  const { model } = view;
  const where = locationIndex(model);
  const seen = new Set<string>();
  const rows: string[] = [];

  const add = (parts: string[]): void => {
    const line = parts.join('\t');
    if (seen.has(line)) return;
    seen.add(line);
    rows.push(line);
  };

  for (const { file } of assignedFiles(model)) {
    for (const fn of model.cards[file]?.functions ?? []) {
      const from = `${file}:${fn.lineRange[0]}`;
      for (const calleeId of fn.calls) {
        const to = where.get(calleeId);
        // An id that resolves to no location is a callee the model's cards do
        // not describe. Guessing a path for it is what invariant 2 forbids.
        if (!to) continue;
        add([fn.qualname, from, calleeQualname(calleeId, model, to), `${to.file}:${to.line}`]);
      }
      // `extCalls` are `<specifier>::<qualname>`: an import the analyzer did not
      // follow. The name is a fact; the location is not, so it is not claimed.
      for (const ext of fn.extCalls) {
        const split = ext.lastIndexOf('::');
        if (split < 0) continue;
        const specifier = ext.slice(0, split);
        const name = ext.slice(split + 2);
        if (name === '') continue;
        add([fn.qualname, from, name, `boundary:${specifier}`]);
      }
    }
  }

  rows.sort(byBytes);
  return `${[
    '# callerQualname\tcallerLocation\tcalleeQualname\tcalleeLocation',
    '# calleeLocation is path:line when the analyzer resolved it, or boundary:<import specifier>',
    '# when the call leaves the scanned set — the name is known, the location is not and is not guessed.',
    '# A call the analyzer could not pin down at all is in phase1/dropped-calls.json,',
    '# never guessed here — so absence is not proof nothing calls it.',
    ...rows,
  ].join('\n')}\n`;
}

/** The callee's own qualname, looked up rather than sliced out of its id. */
function calleeQualname(id: string, model: HandbookModel, at: { file: string; line: number }): string {
  const fn = (model.cards[at.file]?.functions ?? []).find((f: FunctionNote) => f.id === id);
  return fn?.qualname ?? id;
}

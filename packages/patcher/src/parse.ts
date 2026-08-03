/**
 * Parse the EDIT blocks out of a plan produced by `@handbook/planner`.
 *
 * ```
 * ### EDIT 1
 * - file: `src/engine.py`
 * - where: `Engine.spin (~12)` — why
 * ```old
 * <byte-exact current text; empty for a brand-new file>
 * ```
 * ```new
 * <replacement text>
 * ```
 * ```
 *
 * Parsing is deliberately hostile to ambiguity, because a plan is executed
 * against real source. Two rules carry that weight:
 *
 * 1. **Fence tracking follows CommonMark** for both backtick and tilde fences:
 *    a block opened with a run of N markers is closed only by a line whose run
 *    is ≥ N *and* carries no info string. `### EDIT n` inside such a region is
 *    content, never a heading — so a plan that quotes an example edit (say, one
 *    that edits documentation) cannot smuggle a phantom edit into the run.
 * 2. **Structural integrity**: within an EDIT section, everything after the
 *    first fence must live inside a fenced block. If content spills outside —
 *    the signature of an inner fence having closed a block early — the section
 *    is REFUSED with an actionable message ("use a longer opening fence"),
 *    never silently truncated.
 */

export interface EditBlock {
  /** Number as written in the plan (`### EDIT <n>`). */
  index: number;
  /** Repo-relative path exactly as the plan names it. */
  file: string;
  /** The `where:` annotation, for reporting. */
  where: string;
  /** Text to find. Empty string means "create this file". */
  oldText: string;
  /** Replacement text. */
  newText: string;
}

export interface ParsedPlan {
  edits: EditBlock[];
  /** Human-readable problems; a non-empty list means the plan is not applicable. */
  problems: string[];
}

const HEAD_RE = /^ {0,3}###\s+EDIT\s+(\d+)\s*$/;
/** A near-miss heading: caught so a typo reports a problem instead of vanishing. */
const HEAD_LOOSE_RE = /^\s*#{1,6}\s*EDIT\b/i;
/** Fence line: optional indent, a run of ≥3 backticks or tildes, then an info string. */
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const FILE_RE = /^ {0,3}-\s*file:\s*(.+?)\s*$/;
const WHERE_RE = /^ {0,3}-\s*where:\s*(.+?)\s*$/;

interface FenceInfo {
  indent: string;
  marker: string;
  run: number;
  info: string;
}

function fenceOf(line: string): FenceInfo | undefined {
  const match = line.match(FENCE_RE);
  if (!match) return undefined;
  const markers = match[2] as string;
  return {
    indent: match[1] as string,
    marker: markers[0] as string,
    run: markers.length,
    info: (match[3] ?? '').trim(),
  };
}

/** Does `line` close a block opened by `open`? (CommonMark: same marker, ≥ run, no info.) */
function closes(line: string, open: FenceInfo): boolean {
  const fence = fenceOf(line);
  return fence !== undefined && fence.marker === open.marker && fence.run >= open.run && fence.info === '';
}

interface RawSection {
  index: number;
  lines: string[];
}

/** Split the plan into EDIT sections; headings inside fenced regions are content. */
function splitSections(plan: string): { sections: RawSection[]; problems: string[] } {
  const problems: string[] = [];
  const sections: RawSection[] = [];
  const lines = plan.split(/\r?\n/);
  let current: RawSection | undefined;
  let open: FenceInfo | undefined;

  for (const line of lines) {
    if (open) {
      current?.lines.push(line);
      if (closes(line, open)) open = undefined;
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      open = fence;
      current?.lines.push(line);
      continue;
    }
    const head = line.match(HEAD_RE);
    if (head) {
      current = { index: Number(head[1]), lines: [] };
      sections.push(current);
      continue;
    }
    if (HEAD_LOOSE_RE.test(line)) {
      problems.push(`line looks like an edit heading but is not "### EDIT <n>": ${line.trim()}`);
    }
    current?.lines.push(line);
  }
  if (open) problems.push('plan ends inside an unclosed fenced block');
  return { sections, problems };
}

interface Captured {
  kind: string;
  content: string;
}

/**
 * Capture fenced blocks from a section, and report any content that spilled
 * outside them (the tell-tale of an inner fence closing a block early).
 */
function captureFences(lines: readonly string[]): {
  blocks: Captured[];
  headerLines: string[];
  strayAfterFirstFence: string[];
} {
  const blocks: Captured[] = [];
  const headerLines: string[] = [];
  const strayAfterFirstFence: string[] = [];
  let seenFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;
    const open = fenceOf(line);
    if (!open) {
      if (seenFence) {
        if (line.trim() !== '') strayAfterFirstFence.push(line);
      } else {
        headerLines.push(line);
      }
      i += 1;
      continue;
    }
    seenFence = true;
    const body: string[] = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const inner = lines[i] as string;
      if (closes(inner, open)) {
        closed = true;
        i += 1;
        break;
      }
      body.push(inner);
      i += 1;
    }
    if (!closed) strayAfterFirstFence.push('(unclosed fenced block)');
    // Strip up to the opener's indentation from each content line.
    const content = body
      .map((l) => {
        let strip = 0;
        while (strip < open.indent.length && strip < l.length && (l[strip] === ' ' || l[strip] === '\t')) strip += 1;
        return l.slice(strip);
      })
      .join('\n');
    blocks.push({ kind: open.info.toLowerCase(), content });
  }
  return { blocks, headerLines, strayAfterFirstFence };
}

/** Reject paths that are not plain repo-relative POSIX paths. */
function pathProblem(path: string): string | undefined {
  if (path.startsWith('~')) return 'must not start with "~" (no home expansion)';
  if (path.startsWith('/')) return 'must be repo-relative, not absolute';
  if (path.includes('\\')) return 'must use forward slashes';
  if (/\s/.test(path)) return 'must not contain whitespace (drop annotations like "(line 12)")';
  if (path.includes('`')) return 'must not contain backticks';
  return undefined;
}

export function parsePlan(plan: string): ParsedPlan {
  const { sections, problems } = splitSections(plan);
  const edits: EditBlock[] = [];

  if (sections.length === 0) {
    problems.push('no "### EDIT <n>" blocks found in the plan');
    return { edits, problems };
  }

  const seenIndices = new Set<number>();
  let previousIndex = 0;

  for (const section of sections) {
    const { index, lines } = section;
    const label = `EDIT ${index}`;
    if (seenIndices.has(index)) problems.push(`${label}: duplicate edit number`);
    seenIndices.add(index);
    if (index <= previousIndex) problems.push(`${label}: edit numbers must ascend (top-to-bottom order)`);
    previousIndex = index;

    const { blocks, headerLines, strayAfterFirstFence } = captureFences(lines);

    // Structural integrity beats every other check: if text spilled outside the
    // fenced blocks, the block boundaries are not what the author meant.
    if (strayAfterFirstFence.length > 0) {
      problems.push(
        `${label}: content outside the fenced blocks (${JSON.stringify(
          strayAfterFirstFence[0]?.trim().slice(0, 40) ?? '',
        )}…) — an inner fence probably closed a block early; open \`old\`/\`new\` with a LONGER fence (\`\`\`\`) than any fence inside them`,
      );
      continue;
    }

    const fileLines = headerLines.map((l) => l.match(FILE_RE)).filter((m): m is RegExpMatchArray => m !== null);
    const whereLine = headerLines.map((l) => l.match(WHERE_RE)).find((m): m is RegExpMatchArray => m !== null);

    if (fileLines.length === 0) {
      problems.push(`${label}: missing "- file: \`path\`" line before the fenced blocks`);
      continue;
    }
    if (fileLines.length > 1) {
      problems.push(`${label}: ${fileLines.length} "- file:" lines — exactly one is required`);
      continue;
    }
    const file = (fileLines[0]?.[1] ?? '').trim().replace(/^`+|`+$/g, '').trim();
    const badPath = file === '' ? 'is empty' : pathProblem(file);
    if (badPath) {
      problems.push(`${label}: file path "${file}" ${badPath}`);
      continue;
    }

    const oldBlocks = blocks.filter((b) => b.kind === 'old');
    const newBlocks = blocks.filter((b) => b.kind === 'new');
    const unexpected = blocks.filter((b) => b.kind !== 'old' && b.kind !== 'new');
    if (oldBlocks.length !== 1 || newBlocks.length !== 1) {
      problems.push(
        `${label} (${file}): needs exactly one \`\`\`old and one \`\`\`new block (found ${oldBlocks.length} old, ${newBlocks.length} new)`,
      );
      continue;
    }
    if (unexpected.length > 0) {
      problems.push(
        `${label} (${file}): unexpected fenced block(s) tagged ${unexpected
          .map((b) => JSON.stringify(b.kind))
          .join(', ')} — only \`old\` and \`new\` belong in an edit`,
      );
      continue;
    }
    const oldBlock = oldBlocks[0] as Captured;
    const newBlock = newBlocks[0] as Captured;
    if (oldBlock.content === newBlock.content) {
      problems.push(`${label} (${file}): old and new are identical — nothing to do`);
      continue;
    }

    edits.push({
      index,
      file,
      where: (whereLine?.[1] ?? '').trim(),
      oldText: oldBlock.content,
      newText: newBlock.content,
    });
  }

  return { edits, problems };
}

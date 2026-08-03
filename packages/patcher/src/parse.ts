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
 * against real source:
 * - `### EDIT n` is only a heading OUTSIDE fenced regions, so a plan that
 *   quotes an example edit (e.g. one editing documentation) cannot smuggle a
 *   phantom edit into the run;
 * - a block whose content contains a backtick run at least as long as its
 *   opener is REFUSED rather than truncated;
 * - metadata lines are only read before the first fence, so a `- file:` line
 *   inside an `old` block cannot hijack the target;
 * - anything unexpected becomes a `problem`, never a guess.
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

const HEAD_RE = /^###\s+EDIT\s+(\d+)\s*$/;
const FENCE_OPEN_RE = /^([ \t]*)(`{3,})([^\n`]*)$/;
const FILE_RE = /^-\s*file:\s*(.+?)\s*$/;
const WHERE_RE = /^-\s*where:\s*(.+?)\s*$/;

interface RawSection {
  index: number;
  lines: string[];
}

/** Split the plan into EDIT sections, honouring fenced regions. */
function splitSections(plan: string): { sections: RawSection[]; problems: string[] } {
  const problems: string[] = [];
  const sections: RawSection[] = [];
  const lines = plan.split(/\r?\n/);
  let current: RawSection | undefined;
  /** Length of the backtick run that opened the current fence, if any. */
  let openFence: number | undefined;

  for (const line of lines) {
    const fence = line.match(FENCE_OPEN_RE);
    if (openFence === undefined) {
      if (fence) {
        openFence = (fence[2] as string).length;
        current?.lines.push(line);
        continue;
      }
      const head = line.match(HEAD_RE);
      if (head) {
        current = { index: Number(head[1]), lines: [] };
        sections.push(current);
        continue;
      }
      current?.lines.push(line);
      continue;
    }
    // Inside a fence: only a run of at least the opener's length closes it.
    current?.lines.push(line);
    if (fence && (fence[2] as string).length >= openFence && (fence[3] ?? '').trim() === '') {
      openFence = undefined;
    }
  }
  if (openFence !== undefined) problems.push('plan ends inside an unclosed fenced block');
  return { sections, problems };
}

interface Captured {
  kind: string;
  content: string;
  /** True when the block's content held a backtick run ≥ the opener. */
  suspicious: boolean;
}

/** Capture fenced blocks from a section's lines, preserving byte content. */
function captureFences(lines: readonly string[]): { blocks: Captured[]; firstFenceAt: number } {
  const blocks: Captured[] = [];
  let firstFenceAt = lines.length;
  let i = 0;
  while (i < lines.length) {
    const open = (lines[i] as string).match(FENCE_OPEN_RE);
    if (!open) {
      i += 1;
      continue;
    }
    if (firstFenceAt === lines.length) firstFenceAt = i;
    const indent = open[1] as string;
    const runLength = (open[2] as string).length;
    const kind = (open[3] ?? '').trim().toLowerCase();
    const body: string[] = [];
    let suspicious = false;
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const line = lines[i] as string;
      const fence = line.match(FENCE_OPEN_RE);
      if (fence && (fence[2] as string).length >= runLength && (fence[3] ?? '').trim() === '') {
        closed = true;
        i += 1;
        break;
      }
      if (fence && (fence[2] as string).length >= runLength) suspicious = true;
      if (/`{3,}/.test(line)) {
        const longest = Math.max(...[...line.matchAll(/`+/g)].map((m) => m[0].length));
        if (longest >= runLength) suspicious = true;
      }
      body.push(line);
      i += 1;
    }
    if (!closed) suspicious = true;
    // Strip exactly the opener's indentation from each content line.
    const content = body.map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
    blocks.push({ kind, content, suspicious });
  }
  return { blocks, firstFenceAt };
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

    const { blocks, firstFenceAt } = captureFences(lines);
    // Metadata is only read BEFORE the first fence, so fenced content cannot hijack it.
    const header = lines.slice(0, firstFenceAt);
    const fileLines = header.map((l) => l.match(FILE_RE)).filter((m): m is RegExpMatchArray => m !== null);
    const whereLine = header.map((l) => l.match(WHERE_RE)).find((m): m is RegExpMatchArray => m !== null);

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
    if (oldBlocks.length !== 1 || newBlocks.length !== 1) {
      problems.push(
        `${label} (${file}): needs exactly one \`\`\`old and one \`\`\`new block (found ${oldBlocks.length} old, ${newBlocks.length} new)`,
      );
      continue;
    }
    const oldBlock = oldBlocks[0] as Captured;
    const newBlock = newBlocks[0] as Captured;
    if (oldBlock.suspicious || newBlock.suspicious) {
      problems.push(
        `${label} (${file}): a fenced block contains a backtick run as long as its opener — the plan must use a longer opening fence (\`\`\`\`) so the content is unambiguous`,
      );
      continue;
    }
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

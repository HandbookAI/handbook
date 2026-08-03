/**
 * Parse the EDIT blocks out of a plan produced by `@handbook/planner`.
 *
 * The plan format is a contract, not a suggestion:
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
 * Anything that does not match is reported as a parse problem rather than
 * guessed at — a patcher that improvises is worse than one that refuses.
 */

export interface EditBlock {
  /** 1-based index as written in the plan (`### EDIT <n>`). */
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

const EDIT_HEAD_RE = /^###\s+EDIT\s+(\d+)\s*$/gm;
const FILE_RE = /^-\s*file:\s*`?([^`\n]+?)`?\s*$/m;
const WHERE_RE = /^-\s*where:\s*(.+)$/m;

/** Fenced block whose info string starts with `old` or `new`, at line start. */
const FENCE_RE = /^[ \t]*(`{3,})(old|new)[^\n]*\r?\n([\s\S]*?)^[ \t]*\1`*[ \t]*$/gm;

export function parsePlan(plan: string): ParsedPlan {
  const edits: EditBlock[] = [];
  const problems: string[] = [];

  const heads = [...plan.matchAll(EDIT_HEAD_RE)];
  if (heads.length === 0) {
    return { edits, problems: ['no "### EDIT <n>" blocks found in the plan'] };
  }

  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i] as RegExpMatchArray;
    const index = Number(head[1]);
    const start = (head.index ?? 0) + head[0].length;
    const end = i + 1 < heads.length ? (heads[i + 1]?.index ?? plan.length) : plan.length;
    const body = plan.slice(start, end);

    const file = body.match(FILE_RE)?.[1]?.trim();
    const where = body.match(WHERE_RE)?.[1]?.trim() ?? '';
    if (!file) {
      problems.push(`EDIT ${index}: missing "- file: \`path\`" line`);
      continue;
    }

    let oldText: string | undefined;
    let newText: string | undefined;
    for (const fence of body.matchAll(FENCE_RE)) {
      const kind = fence[2];
      const content = stripTrailingNewline(fence[3] ?? '');
      if (kind === 'old' && oldText === undefined) oldText = content;
      else if (kind === 'new' && newText === undefined) newText = content;
    }
    if (oldText === undefined || newText === undefined) {
      problems.push(`EDIT ${index} (${file}): needs one \`\`\`old and one \`\`\`new fenced block`);
      continue;
    }
    if (oldText === newText) {
      problems.push(`EDIT ${index} (${file}): old and new are identical — nothing to do`);
      continue;
    }
    edits.push({ index, file, where, oldText, newText });
  }

  return { edits, problems };
}

/** A fenced block's content carries the newline that precedes its closing fence. */
function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '');
}

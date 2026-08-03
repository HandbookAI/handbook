/**
 * Extract the first JSON value from free-form LLM output.
 *
 * Strategy (mirrors what robust LLM pipelines need in practice):
 * 1. Try every ` ```json ` (or bare ` ``` `) fenced block, first parseable wins.
 * 2. Fall back to a string/escape-aware balanced-brace scan for the first
 *    parseable `{…}` or `[…]` span.
 * 3. Last resort: {@link repairJson} the candidate spans. Models writing prose
 *    routinely quote a phrase with an unescaped `"` inside a JSON string, which
 *    makes an otherwise perfect answer unparseable — repairing it rescues the
 *    content instead of discarding the whole call.
 */

/**
 * Fence openers are anchored to line starts and carry their FULL info string
 * (so ```python and ```python title=x blocks are consumed, not misaligned into
 * the next fence). The opening backtick run is captured and the closing run
 * must be at least as long, so a ````-fenced block keeps its inner ```json
 * examples as literal content (CommonMark semantics). Only fences whose info
 * string starts with `json`/`jsonc` (or is empty) are parse candidates.
 */
const FENCE_RE = /^[ \t]*(`{3,})([^\n`]*)\r?\n([\s\S]*?)^[ \t]*\1`*[ \t]*$/gm;

export function extractJsonBlock(text: string): unknown {
  const fenced: string[] = [];
  for (const match of text.matchAll(FENCE_RE)) {
    const tag = (match[2] ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (tag !== '' && tag !== 'json' && tag !== 'jsonc') continue;
    const candidate = match[3]?.trim();
    if (!candidate) continue;
    fenced.push(candidate);
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next fence
    }
  }
  // A fenced block is the model's DECLARED answer, so a repaired fence beats a
  // balanced-scan fragment: scanning an almost-valid reply happily returns some
  // nested `{…}` that parses (a `functions` map, an empty array) and that
  // fragment then masquerades as the answer.
  for (const candidate of fenced) {
    const repaired = repairJson(candidate);
    if (repaired !== undefined) return repaired;
  }
  const scanned = scanBalanced(text);
  if (scanned !== undefined) return scanned;
  for (const candidate of balancedSpans(text)) {
    const repaired = repairJson(candidate);
    if (repaired !== undefined) return repaired;
  }
  return undefined;
}

/**
 * Parse JSON that is *almost* valid, fixing only the two mistakes models make
 * when they write prose into strings:
 *
 * - an unescaped `"` inside a string (`"拿来"考一遍"。"`) — escaped in place;
 * - a raw newline inside a string — turned into `\n`.
 *
 * A `"` is treated as the string's terminator only when the next non-space
 * character is structural (`,` `:` `}` `]` or end of input); anything else means
 * the quote is part of the text. Returns undefined if the result still does not
 * parse — this never guesses at structure, only at quoting.
 */
export function repairJson(candidate: string): unknown {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i] as string;
    if (!inString) {
      out.push(ch);
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out.push(ch);
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out.push(ch);
      escaped = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      out.push(ch === '\n' ? '\\n' : '\\r');
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < candidate.length && /[ \t\r\n]/.test(candidate[j] as string)) j += 1;
      const next = candidate[j];
      if (next === undefined || next === ',' || next === ':' || next === '}' || next === ']') {
        out.push(ch);
        inString = false;
      } else {
        out.push('\\"'); // a quote inside the prose
      }
      continue;
    }
    out.push(ch);
  }
  try {
    return JSON.parse(out.join(''));
  } catch {
    return undefined;
  }
}

/** Every balanced `{…}`/`[…]` span, for the repair pass to try in order. */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    if (spans.length >= 8) break; // bounded work on adversarial input
  }
  return spans;
}

function scanBalanced(text: string): unknown {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // advance to the next opener
          }
        }
      }
    }
  }
  return undefined;
}

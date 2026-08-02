/**
 * Extract the first JSON value from free-form LLM output.
 *
 * Strategy (mirrors what robust LLM pipelines need in practice):
 * 1. Try every ` ```json ` (or bare ` ``` `) fenced block, first parseable wins.
 * 2. Fall back to a string/escape-aware balanced-brace scan for the first
 *    parseable `{…}` or `[…]` span.
 */

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

export function extractJsonBlock(text: string): unknown {
  for (const match of text.matchAll(FENCE_RE)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next fence
    }
  }
  return scanBalanced(text);
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

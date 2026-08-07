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
 * A fence opener is a line of `indent + ≥3 backticks + info` (the info string
 * carries no backticks). Its closer is a later line of only `indent + ≥opener
 * backticks + whitespace`, so a ````-fenced block keeps its inner ```json
 * examples as literal content (CommonMark semantics). Only fences whose info
 * string starts with `json`/`jsonc` (or is empty) are parse candidates.
 */
const FENCE_OPEN_RE = /^[ \t]*(`{3,})([^`\r\n]*)\r?$/;

/**
 * Total closer-search steps allowed across a whole document. A backtracking
 * regex with a backreference was O(n²) on many opener-like lines that never
 * close (each rescans to end); a budgeted line walk stays bounded.
 */
const MAX_FENCE_SCAN_STEPS = 1_000_000;

/** Backtick count if `line` is only indent + backticks + trailing space, else -1. */
function fenceCloserTicks(line: string): number {
  let k = 0;
  const n = line.length;
  while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
  let ticks = 0;
  while (k < n && line[k] === '`') {
    ticks += 1;
    k += 1;
  }
  while (k < n && (line[k] === ' ' || line[k] === '\t' || line[k] === '\r')) k += 1;
  return k === n && ticks > 0 ? ticks : -1;
}

/** Enumerate fenced blocks in one O(n) line walk (no backtracking regex). */
function* fencedBlocks(text: string): Generator<{ info: string; body: string }> {
  const lines = text.split('\n');
  let steps = 0;
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN_RE.exec(lines[i] as string);
    if (!open) {
      i += 1;
      continue;
    }
    const need = (open[1] as string).length;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if ((steps += 1) > MAX_FENCE_SCAN_STEPS) return; // bounded on unclosed floods
      if (fenceCloserTicks(lines[j] as string) >= need) break;
    }
    if (j < lines.length) {
      yield { info: (open[2] ?? '').trim(), body: lines.slice(i + 1, j).join('\n') };
      i = j + 1; // resume after the closer
    } else {
      i += 1; // unclosed opener: not a block, mirror the old regex
    }
  }
}

export function extractJsonBlock(text: string): unknown {
  const fenced: string[] = [];
  for (const { info, body } of fencedBlocks(text)) {
    const tag = info.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (tag !== '' && tag !== 'json' && tag !== 'jsonc') continue;
    const candidate = body.trim();
    if (!candidate) continue;
    fenced.push(candidate);
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next fence
    }
  }
  // A fenced block is the model's DECLARED answer. If one exists, it is the only
  // thing worth reading: scanning an almost-valid reply for a balanced span
  // happily returns some NESTED object that parses on its own (a `functions`
  // map, an empty array) and that fragment then masquerades as the answer —
  // which downstream shape tolerance would dutifully accept. So repair the
  // fences, and if none can be repaired, report failure instead of guessing.
  for (const candidate of fenced) {
    const repaired = repairJson(candidate);
    if (repaired !== undefined) return repaired;
  }
  if (fenced.length > 0) return undefined;
  const scanned = scanBalanced(text);
  if (scanned !== undefined) return scanned;
  for (const candidate of balancedSpans(text)) {
    const repaired = repairJson(candidate);
    if (repaired !== undefined) return repaired;
  }
  return undefined;
}

/**
 * Parse JSON that is *almost* valid, tolerating exactly two mistakes models make
 * when they write prose into strings:
 *
 * - an unescaped `"` inside a string (`"拿来"考一遍"。"`, `a "queue": a line`);
 * - a raw newline inside a string.
 *
 * An unescaped quote is genuinely ambiguous: in `"supports "list", "map"…"` the
 * quote before `,` looks exactly like a terminator. So this does not guess — it
 * BACKTRACKS. At every quote inside a string both readings are tried (terminator
 * first, then literal), and a reading is accepted only if the whole document
 * parses from it. That means the answer is either recovered exactly or reported
 * as undefined; a half-parsed document is never returned.
 *
 * Structure is never invented: brackets are never auto-closed, so truncated
 * input yields undefined. A trailing comma IS accepted — unlike a quote it is
 * unambiguous, so tolerating it cannot change what the answer means. Work is
 * bounded by {@link MAX_REPAIR_STEPS} so adversarial input cannot hang a caller.
 */
export function repairJson(candidate: string): unknown {
  const text = candidate;
  // Valid JSON has exactly one meaning, so honour the "leaves valid JSON alone"
  // contract directly. Without this, the backtracker below also explores reading
  // a properly-escaped `\"` string's real closing quote as literal prose, and the
  // odd-quote tiebreak can then prefer a WRONG reading that merges two escaped-
  // quote values into one — corrupting input that JSON.parse handles exactly.
  try {
    return JSON.parse(text);
  } catch {
    // not valid as-is; fall through to the tolerant, backtracking repair
  }
  let steps = 0;
  /** Budget exhausted → stop generating candidates rather than hang. */
  const spend = (): boolean => (steps += 1) <= MAX_REPAIR_STEPS;

  const skipWs = (i: number): number => {
    let j = i;
    while (j < text.length && /[ \t\r\n]/.test(text[j] as string)) j += 1;
    return j;
  };

  /**
   * Yield every plausible reading of the string starting at `i` (which points at
   * the opening quote), shortest first — the shortest is what valid JSON means.
   */
  function* readString(i: number): Generator<[string, number]> {
    let out = '';
    let j = i + 1;
    while (j < text.length) {
      const ch = text[j] as string;
      if (ch === '\\') {
        const next = text[j + 1];
        if (next === undefined) return;
        const simple: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
          '"': '"',
          '\\': '\\',
          '/': '/',
        };
        if (next === 'u') {
          const hex = text.slice(j + 2, j + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return;
          out += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        const mapped = simple[next];
        if (mapped === undefined) return; // invalid escape: not repairable
        out += mapped;
        j += 2;
        continue;
      }
      if (ch === '"') {
        if (!spend()) return;
        yield [out, j + 1]; // reading A: the string ends here
        out += '"'; // reading B: the quote is part of the prose — keep looking
        j += 1;
        continue;
      }
      out += ch; // raw newlines and control characters are taken literally
      j += 1;
    }
  }

  function* readValue(i: number): Generator<[unknown, number]> {
    if (!spend()) return;
    const at = skipWs(i);
    const ch = text[at];
    if (ch === undefined) return;
    if (ch === '"') {
      yield* readString(at);
      return;
    }
    if (ch === '{') {
      yield* readObject(at);
      return;
    }
    if (ch === '[') {
      yield* readArray(at);
      return;
    }
    const literal = /^(true|false|null)/.exec(text.slice(at));
    if (literal) {
      const word = literal[1] as string;
      yield [word === 'true' ? true : word === 'false' ? false : null, at + word.length];
      return;
    }
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at));
    if (number) yield [Number(number[0]), at + number[0].length];
  }

  function* readObject(open: number): Generator<[Record<string, unknown>, number]> {
    function* pairs(i: number, acc: Array<[string, unknown]>): Generator<[Record<string, unknown>, number]> {
      if (!spend()) return;
      const at = skipWs(i);
      if (text[at] === '}') {
        yield [Object.fromEntries(acc), at + 1];
        return;
      }
      if (text[at] !== '"') return; // keys must be quoted
      for (const [key, afterKey] of readString(at)) {
        const colon = skipWs(afterKey);
        if (text[colon] !== ':') continue;
        for (const [value, afterValue] of readValue(colon + 1)) {
          const next = skipWs(afterValue);
          if (text[next] === ',') yield* pairs(next + 1, [...acc, [key, value]]);
          else if (text[next] === '}') yield [Object.fromEntries([...acc, [key, value]]), next + 1];
        }
      }
    }
    yield* pairs(open + 1, []);
  }

  function* readArray(open: number): Generator<[unknown[], number]> {
    function* items(i: number, acc: unknown[]): Generator<[unknown[], number]> {
      if (!spend()) return;
      const at = skipWs(i);
      if (text[at] === ']') {
        yield [acc, at + 1];
        return;
      }
      for (const [value, afterValue] of readValue(at)) {
        const next = skipWs(afterValue);
        if (text[next] === ',') yield* items(next + 1, [...acc, value]);
        else if (text[next] === ']') yield [[...acc, value], next + 1];
      }
    }
    yield* items(open + 1, []);
  }

  // Several readings can parse. `"supports "list", "map" and "filter""` is either
  // one prose string or two shorter ones — both are valid JSON. Collect the
  // readings and pick by a property of real prose: an unescaped quote comes in
  // PAIRS (it opens and closes a quoted term), so a reading that leaves strings
  // holding an odd number of quotes has cut one of those pairs in half.
  // The backtracker recurses once per nesting level AND once per array element /
  // object key, so an enormous candidate can exhaust the call stack. A partial
  // reading never satisfies the `end === length` check, so overflow can only
  // ever cost a would-be answer — treat it as "unrepairable" instead of letting
  // a RangeError escape and crash the caller. The handler runs after the stack
  // has unwound, so it has ample headroom.
  const parses: unknown[] = [];
  try {
    for (const [value, end] of readValue(0)) {
      if (skipWs(end) !== text.length) continue;
      parses.push(value);
      if (parses.length >= MAX_REPAIR_PARSES) break;
    }
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  if (parses.length === 0) return undefined;
  let best = parses[0];
  let bestScore = oddQuoteStrings(best);
  for (const parse of parses.slice(1)) {
    const score = oddQuoteStrings(parse);
    if (score < bestScore) {
      best = parse;
      bestScore = score;
    }
  }
  return best;
}

/** How many strings in `value` hold an odd number of `"` — i.e. a split pair. */
function oddQuoteStrings(value: unknown): number {
  if (typeof value === 'string') return (value.match(/"/g)?.length ?? 0) % 2;
  if (Array.isArray(value)) return value.reduce<number>((sum, v) => sum + oddQuoteStrings(v), 0);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).reduce(
      (sum, [key, v]) => sum + oddQuoteStrings(key) + oddQuoteStrings(v),
      0,
    );
  }
  return 0;
}

/** How many complete readings to weigh before choosing. */
const MAX_REPAIR_PARSES = 64;

/** Backtracking budget: enough for real replies, bounded for adversarial ones. */
const MAX_REPAIR_STEPS = 200_000;

/**
 * Naive-scan budget for {@link balancedSpans}. A long run of unbalanced openers
 * (`{{{{…`) makes a per-opener rescan O(n²); this caps total inner steps so an
 * adversarial reply cannot stall the repair pass.
 */
const MAX_SPAN_SCAN_STEPS = 1_000_000;

/** Absolute cap on characters handed to `JSON.parse` during a balanced scan. */
const MAX_SCAN_PARSE_CHARS = 8_000_000;

/** Every balanced `{…}`/`[…]` span, for the repair pass to try in order. */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  let steps = 0;
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      if ((steps += 1) > MAX_SPAN_SCAN_STEPS) return spans; // bounded on `{{{…`
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

/**
 * Map every properly-matched `{`/`[` opener index to its closer index in ONE
 * string-aware left-to-right pass. Brackets inside JSON strings are ignored; a
 * mismatched closer clears the open stack, because no valid JSON value can
 * straddle it. This is O(n): the previous per-opener rescan was O(n²) and a
 * ~20KB reply of unbalanced braces stalled extraction for seconds.
 */
function matchBrackets(text: string): Map<number, number> {
  const closeOf = new Map<number, number>();
  const stack: Array<[string, number]> = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push([ch, i]);
    else if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if (!top) continue; // stray closer
      if (ch === (top[0] === '{' ? '}' : ']')) {
        stack.pop();
        closeOf.set(top[1], i);
      } else {
        stack.length = 0; // mismatch: nothing on the stack can still balance
      }
    }
  }
  return closeOf;
}

function scanBalanced(text: string): unknown {
  const closeOf = matchBrackets(text);
  // Iterating `i` upward visits openers in ascending order, so the first span
  // that parses is the earliest-starting one — matching "the first parseable
  // span" without an O(n²) rescan. Parse work is char-capped for pathological
  // inputs (many large nested spans that each fail to parse).
  let parsed = 0;
  for (let i = 0; i < text.length; i += 1) {
    const end = closeOf.get(i);
    if (end === undefined) continue;
    const slice = text.slice(i, end + 1);
    if ((parsed += slice.length) > MAX_SCAN_PARSE_CHARS) break;
    try {
      return JSON.parse(slice);
    } catch {
      // not valid JSON on its own; try the next opener
    }
  }
  return undefined;
}

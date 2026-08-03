/**
 * Read list-shaped answers out of an LLM reply.
 *
 * A prompt asks for `{"assignments": [...]}`; a model may answer with the bare
 * array, name the container `files`, or — when the prompt carried exactly one
 * item — return a single un-wrapped object. All of those are the same answer.
 * Accepting only the requested spelling means a correct reply is discarded as a
 * failure, which is how a run ends up with empty output while reporting success.
 *
 * This never invents content: it only looks for the list the model did send.
 */

/** Container keys tried after the caller's own, in order. */
const GENERIC_KEYS = ['items', 'entries', 'results', 'data', 'list'] as const;

/**
 * Pull an array of objects from `json`.
 *
 * @param json    the parsed reply (`ChatResult.json`)
 * @param keys    container keys to accept, most-expected first
 * @param options `single` also accepts one un-wrapped object as a 1-item list,
 *                recognised by carrying at least one of `fields`
 */
export function extractEntryList(
  json: unknown,
  keys: readonly string[],
  options: { single?: { fields: readonly string[] } } = {},
): Array<Record<string, unknown>> {
  // An array that holds no plain objects is NOT a match: returning an empty list
  // would short-circuit the remaining container keys and the `single` fallback,
  // discarding a real list sitting under the next key. Arrays are excluded too —
  // callers are typed for objects, and a nested array would reach them as one.
  const asList = (value: unknown): Array<Record<string, unknown>> | undefined => {
    if (!Array.isArray(value)) return undefined;
    const objects = value.filter(
      (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
    );
    return objects.length > 0 ? objects : undefined;
  };

  if (Array.isArray(json)) return asList(json) ?? [];
  if (typeof json !== 'object' || json === null) return [];
  const record = json as Record<string, unknown>;

  for (const key of [...keys, ...GENERIC_KEYS]) {
    const hit = asList(record[key]);
    if (hit) return hit;
  }
  // A nested wrapper: {"result": {"assignments": [...]}}.
  for (const value of Object.values(record)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    for (const key of keys) {
      const hit = asList((value as Record<string, unknown>)[key]);
      if (hit) return hit;
    }
  }
  const fields = options.single?.fields;
  if (fields && fields.some((field) => field in record)) return [record];
  return [];
}

/** A short, log-safe description of a reply's actual JSON shape. */
export function describeJsonShape(json: unknown): string {
  if (json === undefined || json === null) return 'no JSON block in the reply';
  if (Array.isArray(json)) return `top-level array of ${json.length}`;
  if (typeof json !== 'object') return `top-level ${typeof json}`;
  const keys = Object.keys(json as object);
  return `keys: ${keys.slice(0, 8).join(', ') || '(none)'}${keys.length > 8 ? ', …' : ''}`;
}

/** First 200 characters of a reply, collapsed to one line, for a log message. */
export function replyExcerpt(text: string, limit = 200): string {
  return JSON.stringify(text.trim().slice(0, limit).replace(/\s+/g, ' '));
}

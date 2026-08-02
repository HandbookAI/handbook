/** Small text utilities shared by prompts and renderers. */

/** Truncate to `max` chars, appending an ellipsis when truncated. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * First sentence of a paragraph. Understands both `. ` and CJK `。`
 * terminators; falls back to the whole (trimmed) text.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const western = trimmed.indexOf('. ');
  const cjk = trimmed.indexOf('。');
  const cut = [western >= 0 ? western + 1 : -1, cjk >= 0 ? cjk + 1 : -1].filter((i) => i > 0);
  if (cut.length === 0) return trimmed;
  return trimmed.slice(0, Math.min(...cut)).trim();
}

/** URL/anchor-safe slug: lowercase, alphanumerics preserved, runs of other chars → `-`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Render `names` capped at `cap` entries with a `(+K more)` suffix. */
export function capList(names: readonly string[], cap: number, joiner = ', '): string {
  if (names.length <= cap) return names.join(joiner);
  return `${names.slice(0, cap).join(joiner)} (+${names.length - cap} more)`;
}

/** The leaf segment of a dotted/:: qualified name. */
export function leafName(qualname: string): string {
  const parts = qualname.split('::').pop() ?? qualname;
  return parts.split('.').pop() ?? parts;
}

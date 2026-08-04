/**
 * Minimal .env loader (dependency-free).
 *
 * Supported syntax: `KEY=value`, optional `export ` prefix, blank lines,
 * `#` comment lines, single/double-quoted values (quotes stripped), and
 * ` #` inline comments on unquoted values. No multiline values.
 *
 * Loading NEVER overrides variables already present in the environment —
 * the shell always wins over the file.
 */
import { readFileSync } from 'node:fs';

// The value is captured WITHOUT consuming the whitespace after `=`, so an empty
// value trailed by a comment (`KEY= # note`) keeps the space that marks the
// comment; otherwise `\s*` would eat it and the `# note` would become the value.
const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Drop a trailing whitespace-preceded `#` inline comment from a value, then trim. */
function stripInlineComment(value: string): string {
  const at = /[ \t]#/.exec(value);
  return (at ? value.slice(0, at.index) : value).trim();
}

/** Parse .env content into a key→value map. Malformed lines are skipped. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on CRLF, bare CR (classic-Mac), and LF so no line-ending convention
  // silently collapses the whole file into one unparseable line.
  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(LINE_RE);
    if (!match) continue;
    const key = match[1] as string;
    const raw = match[2] ?? '';
    // Leading indentation between `=` and the value is not part of it; drop it
    // for quote detection, but keep `raw` for comment stripping so a leading
    // ` #` on an otherwise-empty value is still recognised as a comment.
    const trimmed = raw.replace(/^[ \t]+/, '');
    const quote = trimmed[0];
    let value: string;
    if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
      // Fully quoted value: strip the surrounding quotes verbatim.
      value = trimmed.slice(1, -1);
    } else if (quote === '"' || quote === "'") {
      // Opens with a quote but does not end with one — a quoted value trailed by
      // content, typically an inline `# comment`. Take the span up to the
      // matching close quote and ignore what follows ONLY when it is nothing but
      // whitespace and/or a `#` comment; otherwise the input is not a clean
      // quoted value, so fall back to unquoted handling rather than reshaping it.
      const close = trimmed.indexOf(quote, 1);
      const tail = close >= 0 ? trimmed.slice(close + 1).trim() : '';
      value = close >= 0 && (tail === '' || tail.startsWith('#')) ? trimmed.slice(1, close) : stripInlineComment(raw);
    } else {
      value = stripInlineComment(raw);
    }
    // A literal `__proto__=…` line is well-formed and must be preserved as data;
    // a plain assignment would hit Object.prototype's setter and silently vanish.
    if (key === '__proto__') {
      Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Load `path` into `env`. Existing keys are never overridden.
 * Returns the keys actually applied.
 */
export function applyEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && env[key] !== '') continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      value =
        close >= 0 && (tail === '' || tail.startsWith('#'))
          ? trimmed.slice(1, close)
          : stripInlineComment(raw);
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

/**
 * Loads the per-environment `.env*` cascade in `dir`, highest precedence
 * first — personal beats team, and this environment beats the baseline:
 *
 *   .env.<name>.local   personal, this environment only (gitignored)
 *   .env.<name>         team, this environment only (committed)
 *   .env.local          personal, every environment (gitignored)
 *   .env                team baseline (committed)
 *
 * `name` is undefined when neither `--env` nor `HANDBOOK_ENV` names one, in
 * which case only the last two files are tried — the exact pair that loaded
 * before this cascade existed, so a run that does not name an environment
 * sees no behaviour change. `applyEnvFile`'s own "never override" rule is
 * what makes a cascade nothing more than "call it in this order, first
 * writer wins": the shell keeps outranking every file with no extra logic
 * here, and a more specific file simply gets first refusal on every key.
 *
 * Silent about a candidate that does not exist — that is the normal case for
 * most of these files on most machines. Returns the paths that were actually
 * loaded, in the same highest-first order, for `handbook config` to display.
 */
export function applyEnvFiles(
  dir: string,
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = name
    ? [`.env.${name}.local`, `.env.${name}`, '.env.local', '.env']
    : ['.env.local', '.env'];
  const loaded: string[] = [];
  for (const file of candidates) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    applyEnvFile(path, env);
    loaded.push(path);
  }
  return loaded;
}

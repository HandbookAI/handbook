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

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parse .env content into a key→value map. Malformed lines are skipped. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(LINE_RE);
    if (!match) continue;
    const key = match[1] as string;
    let value = match[2] ?? '';
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
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

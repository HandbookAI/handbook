/**
 * Validate a handbook SKILL directory: structure, frontmatter contract,
 * index↔stage-page consistency, and (when coverage.json + a source root are
 * available) content-hash freshness against the live source.
 */
import { readFileSync } from 'node:fs';
import { basename, join, normalize, resolve, sep } from 'node:path';
import { fileExists, listFilesRecursive, readJsonFile, sha256Hex } from '@handbook/core';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidateSkillOptions {
  skillDir: string;
  /** When given and coverage.json exists, re-hash source files to detect drift. */
  sourceRoot?: string;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSkill(options: ValidateSkillOptions): ValidationResult {
  const { skillDir } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- SKILL.md ---
  const skillPath = join(skillDir, 'SKILL.md');
  if (!fileExists(skillPath)) {
    errors.push('SKILL.md is missing');
  } else {
    const text = readFileSync(skillPath, 'utf8');
    // Tolerate a leading UTF-8 BOM and CRLF endings: a SKILL.md checked out on
    // Windows (or with git autocrlf) is still valid, and corrections.jsonl below
    // is already parsed CRLF-tolerantly — the frontmatter must match.
    const front = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!front || !front[1]) {
      errors.push('SKILL.md has no YAML frontmatter');
    } else {
      const fields = new Map<string, string>();
      for (const line of front[1].split(/\r?\n/)) {
        if (!line.trim()) continue;
        const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (!kv) {
          errors.push(`SKILL.md frontmatter line is not "key: value": ${line.trim()}`);
          continue;
        }
        const key = kv[1] as string;
        // A Map would silently let a second `name:`/`description:` overwrite the
        // first, so a frontmatter with duplicate keys is genuinely ambiguous —
        // flag it instead of quietly accepting whichever line happened to win.
        if (fields.has(key)) errors.push(`SKILL.md frontmatter has a duplicate "${key}" key`);
        fields.set(key, kv[2] as string);
      }
      const keys = [...fields.keys()].sort();
      if (keys.join(',') !== 'description,name') {
        errors.push(`SKILL.md frontmatter must have exactly name+description, found: ${keys.join(', ')}`);
      }
      const name = fields.get('name') ?? '';
      if (!NAME_RE.test(name)) errors.push(`SKILL.md name "${name}" is not a lowercase-hyphen slug`);
      const description = (fields.get('description') ?? '').toLowerCase();
      if (!description.includes('use when'))
        errors.push('SKILL.md description must state when to USE it ("Use when …")');
      if (!description.includes('do not use'))
        errors.push('SKILL.md description must state when NOT to use it ("Do not use …")');
    }
    if (!text.includes('references/index.md'))
      errors.push('SKILL.md body must reference references/index.md');
    // The body may be localized (en/zh) — accept either phrasing. The
    // frontmatter contract above is language-independent: it stays English.
    if (!/actual source|real source|真实源码/i.test(text)) {
      errors.push('SKILL.md body must direct agents to read the actual source');
    }
  }

  // --- required references ---
  const referencesDir = join(skillDir, 'references');
  for (const required of ['overview.md', 'index.md', 'registers.md']) {
    if (!fileExists(join(referencesDir, required))) errors.push(`references/${required} is missing`);
  }
  const stagesDir = join(referencesDir, 'stages');
  if (!fileExists(stagesDir)) {
    errors.push('references/stages/ is missing');
  }

  // --- agent locator pages (optional subdirectory) ---
  // Skills without references/agent/ are valid; when the dir exists it should
  // carry both locator pages, each non-empty. A missing page is a warning —
  // the skill still routes — but an empty page is a broken reference: error.
  const agentRefDir = join(referencesDir, 'agent');
  if (fileExists(agentRefDir)) {
    const missing: string[] = [];
    for (const page of ['how_to_use.md', 'disambiguation.md']) {
      const path = join(agentRefDir, page);
      if (!fileExists(path)) {
        missing.push(page);
        continue;
      }
      if (readFileSync(path, 'utf8').trim().length === 0) errors.push(`references/agent/${page} is empty`);
    }
    if (missing.length > 0) {
      warnings.push(
        `references/agent/ is missing ${missing.join(' and ')} — the locator pair should ship together`,
      );
    }
  }

  // --- index ↔ stage pages (both directions) ---
  const indexPath = join(referencesDir, 'index.md');
  if (fileExists(indexPath) && fileExists(stagesDir)) {
    const index = readFileSync(indexPath, 'utf8');
    const pages = listFilesRecursive(stagesDir, { extensions: ['.md'] }).map((p) => basename(p, '.md'));
    if (pages.length === 0) warnings.push('references/stages/ contains no pages');
    for (const sid of pages) {
      const count = index.split(`${sid}.md`).length - 1;
      if (count === 0) errors.push(`index.md never links stage page ${sid}.md`);
    }
    // Every markdown link in the index that targets a stage page must exist —
    // a linked-but-missing page means the skill silently lost content.
    const pageSet = new Set(pages.map((p) => `${p}.md`));
    const known = new Set(['overview.md', 'index.md', 'register.md', 'registers.md']);
    for (const match of index.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
      const target = basename(match[1] ?? '');
      if (!target || known.has(target.toLowerCase())) continue;
      if (!pageSet.has(target))
        errors.push(`index.md links ${target} but references/stages/${target} is missing`);
    }
  }

  // --- coverage freshness ---
  const coveragePath = join(referencesDir, 'coverage.json');
  if (fileExists(coveragePath)) {
    try {
      const coverage = readJsonFile(coveragePath) as {
        files?: unknown;
      };
      // A malformed entry (null, a string, a wrong-typed field) must not derail
      // drift detection with a misleading "unreadable" — keep only plain objects.
      const files = (Array.isArray(coverage.files) ? coverage.files : []).filter(
        (f): f is { path?: unknown; stage?: unknown; sha256?: unknown } =>
          typeof f === 'object' && f !== null && !Array.isArray(f),
      );
      const seen = new Set<string>();
      for (const f of files) {
        if (typeof f.path !== 'string') continue;
        if (seen.has(f.path)) errors.push(`coverage.json lists ${f.path} twice`);
        seen.add(f.path);
      }
      if (options.sourceRoot) {
        const rootAbs = resolve(options.sourceRoot);
        const stale: string[] = [];
        const deleted: string[] = [];
        const unsafe: string[] = [];
        for (const f of files) {
          if (typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !f.sha256) continue;
          // Never let a coverage path escape the source root: `../` (or an
          // absolute/backslash path) would make us read — and hash — arbitrary
          // files off-tree, a path-escape read and a DoS on device/huge files.
          if (f.path.startsWith('/') || f.path.includes('\\')) {
            unsafe.push(f.path);
            continue;
          }
          const full = resolve(rootAbs, normalize(f.path));
          if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
            unsafe.push(f.path);
            continue;
          }
          if (!fileExists(full)) {
            deleted.push(f.path);
            continue;
          }
          if (sha256Hex(readFileSync(full)) !== f.sha256) stale.push(f.path);
        }
        if (unsafe.length > 0) {
          errors.push(
            `coverage.json lists path(s) that escape the source root: ${unsafe.slice(0, 20).join(', ')}`,
          );
        }
        if (deleted.length > 0) {
          errors.push(
            `coverage lists deleted files: ${deleted.slice(0, 20).join(', ')}${deleted.length > 20 ? ` … and ${deleted.length - 20} more` : ''}`,
          );
        }
        if (stale.length > 0) {
          errors.push(
            `coverage hashes are stale for: ${stale.slice(0, 20).join(', ')}${stale.length > 20 ? ` … and ${stale.length - 20} more` : ''}`,
          );
        }
      }
    } catch (error) {
      errors.push(`coverage.json is unreadable: ${String(error)}`);
    }
  } else {
    warnings.push('references/coverage.json is absent — no drift detection possible');
  }

  // --- corrections feedback channel ---
  // Agents append correction records to corrections.jsonl at the SKILL ROOT
  // (references/ is mounted read-only). Absent file: silence — nothing was
  // reported. Present: parse tolerantly line by line; a line that is not a
  // JSON object with a non-empty `file` string is a record resync could never
  // apply, so it errors with its line number. Valid records are pending work:
  // surface them as a warning until a resync folds them in and archives the file.
  const correctionsPath = join(skillDir, 'corrections.jsonl');
  if (fileExists(correctionsPath)) {
    let pending = 0;
    const lines = readFileSync(correctionsPath, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        errors.push(`corrections.jsonl line ${index + 1} is not valid JSON`);
        continue;
      }
      const file =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as { file?: unknown }).file
          : undefined;
      if (typeof file !== 'string' || file.length === 0) {
        errors.push(`corrections.jsonl line ${index + 1} has no non-empty "file" string`);
        continue;
      }
      pending += 1;
    }
    if (pending > 0) {
      warnings.push(`${pending} unprocessed correction(s) — resync with --corrections to fold them in`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

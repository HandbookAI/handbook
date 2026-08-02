/**
 * Validate a handbook SKILL directory: structure, frontmatter contract,
 * index↔stage-page consistency, and (when coverage.json + a source root are
 * available) content-hash freshness against the live source.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!front || !front[1]) {
      errors.push('SKILL.md has no YAML frontmatter');
    } else {
      const fields = new Map<string, string>();
      for (const line of front[1].split('\n')) {
        if (!line.trim()) continue;
        const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (!kv) {
          errors.push(`SKILL.md frontmatter line is not "key: value": ${line.trim()}`);
          continue;
        }
        fields.set(kv[1] as string, kv[2] as string);
      }
      const keys = [...fields.keys()].sort();
      if (keys.join(',') !== 'description,name') {
        errors.push(`SKILL.md frontmatter must have exactly name+description, found: ${keys.join(', ')}`);
      }
      const name = fields.get('name') ?? '';
      if (!NAME_RE.test(name)) errors.push(`SKILL.md name "${name}" is not a lowercase-hyphen slug`);
      const description = (fields.get('description') ?? '').toLowerCase();
      if (!description.includes('use when')) errors.push('SKILL.md description must state when to USE it ("Use when …")');
      if (!description.includes('do not use')) errors.push('SKILL.md description must state when NOT to use it ("Do not use …")');
    }
    if (!text.includes('references/index.md')) errors.push('SKILL.md body must reference references/index.md');
    if (!/actual source|real source/i.test(text)) {
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

  // --- index ↔ stage pages ---
  const indexPath = join(referencesDir, 'index.md');
  if (fileExists(indexPath) && fileExists(stagesDir)) {
    const index = readFileSync(indexPath, 'utf8');
    const pages = listFilesRecursive(stagesDir, { extensions: ['.md'] }).map((p) => basename(p, '.md'));
    if (pages.length === 0) warnings.push('references/stages/ contains no pages');
    for (const sid of pages) {
      const count = index.split(`${sid}.md`).length - 1;
      if (count === 0) errors.push(`index.md never links stage page ${sid}.md`);
    }
  }

  // --- coverage freshness ---
  const coveragePath = join(referencesDir, 'coverage.json');
  if (fileExists(coveragePath)) {
    try {
      const coverage = readJsonFile(coveragePath) as {
        files?: Array<{ path?: string; stage?: string; sha256?: string }>;
      };
      const files = Array.isArray(coverage.files) ? coverage.files : [];
      const seen = new Set<string>();
      for (const f of files) {
        if (typeof f.path !== 'string') continue;
        if (seen.has(f.path)) errors.push(`coverage.json lists ${f.path} twice`);
        seen.add(f.path);
      }
      if (options.sourceRoot) {
        const stale: string[] = [];
        const deleted: string[] = [];
        for (const f of files) {
          if (typeof f.path !== 'string' || !f.sha256) continue;
          const full = join(options.sourceRoot, f.path);
          if (!fileExists(full)) {
            deleted.push(f.path);
            continue;
          }
          if (sha256Hex(readFileSync(full)) !== f.sha256) stale.push(f.path);
        }
        if (deleted.length > 0) {
          errors.push(`coverage lists deleted files: ${deleted.slice(0, 20).join(', ')}${deleted.length > 20 ? ` … and ${deleted.length - 20} more` : ''}`);
        }
        if (stale.length > 0) {
          errors.push(`coverage hashes are stale for: ${stale.slice(0, 20).join(', ')}${stale.length > 20 ? ` … and ${stale.length - 20} more` : ''}`);
        }
      }
    } catch (error) {
      errors.push(`coverage.json is unreadable: ${String(error)}`);
    }
  } else {
    warnings.push('references/coverage.json is absent — no drift detection possible');
  }

  return { ok: errors.length === 0, errors, warnings };
}

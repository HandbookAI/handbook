/**
 * Package a rendered handbook directory as an agent SKILL:
 *
 * ```
 * <out>/
 *   SKILL.md                 navigation guide (how an agent should route)
 *   references/
 *     overview.md  index.md  registers.md
 *     stages/<sid>.md        one page per stage
 *     coverage.json          file → stage + content hashes (optional, drift signal)
 * ```
 *
 * The skill is self-contained and shareable; it never embeds source code.
 */
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  ensureDir,
  fileExists,
  listFilesRecursive,
  sha256Hex,
  writeFileAtomic,
  writeJsonFile,
  type Assignment,
} from '@handbook/core';

export interface BuildSkillOptions {
  /** Rendered handbook dir (contains overview.md/index.md/register.md/<sid>.md). */
  handbookDir: string;
  outDir: string;
  /** Skill slug, e.g. `myproject`. Produces name `<slug>-handbook`. */
  name: string;
  /** Human project name used in prose. Defaults to `name`. */
  project?: string;
  /** When given, coverage.json records file→stage plus source hashes for drift detection. */
  coverage?: { assignment: Assignment; sourceRoot?: string };
}

export interface BuildSkillResult {
  outDir: string;
  nStagePages: number;
  references: string[];
}

const STAGE_PAGE_RE = /^(stage|crosscut|side)-[a-z0-9.-]+\.md$/i;

function skillMd(name: string, project: string): string {
  return `---
name: ${name}-handbook
description: Navigate the ${project} codebase by behavior and source location. Use when planning, implementing, debugging, or reviewing ${project} work that is unfamiliar, spans multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to ${project} or isolated edits where the exact file is already known and no cross-cutting impact is plausible.
---

# ${project} Handbook — how to use it

This handbook is a **location index** for the ${project} codebase, not a code description.
Use it to decide WHICH files, functions and state a change must touch — then read the real source.

1. Read \`references/overview.md\` for the system's shape.
2. Route through \`references/index.md\` — the stage index maps every subsystem to its files.
3. Open only the relevant \`references/stages/<id>.md\` pages.
4. Check \`references/registers.md\` for cross-cutting state — invaluable for fan-out changes.
5. \`read_file\` the actual source at every cited path before proposing or making changes.

If \`references/coverage.json\` exists, treat its content hashes as freshness signals: a stale
hash means the page may lag the code. Do NOT treat handbook prose as ground truth for code
text — always confirm against the real source before emitting a verbatim edit.
`;
}

export function buildSkill(options: BuildSkillOptions): BuildSkillResult {
  const { handbookDir, outDir } = options;
  const project = options.project ?? options.name;
  if (!fileExists(join(handbookDir, 'index.md'))) {
    throw new Error(`${handbookDir} is not a rendered handbook (missing index.md)`);
  }
  rmSync(outDir, { recursive: true, force: true });
  const referencesDir = join(outDir, 'references');
  const stagesDir = join(referencesDir, 'stages');
  ensureDir(stagesDir);

  writeFileAtomic(join(outDir, 'SKILL.md'), skillMd(options.name, project));

  const references: string[] = [];
  const copyMap: Array<[string, string[]]> = [
    ['overview.md', ['overview.md']],
    ['index.md', ['index.md']],
    ['registers.md', ['registers.md', 'register.md']],
  ];
  for (const [dest, candidates] of copyMap) {
    const source = candidates.map((c) => join(handbookDir, c)).find(fileExists);
    if (source) {
      copyFileSync(source, join(referencesDir, dest));
      references.push(dest);
    }
  }

  // Stage pages: nested stages/ dir wins, else flat `<sid>.md` at the root.
  let stagePages: string[];
  if (fileExists(join(handbookDir, 'stages'))) {
    stagePages = listFilesRecursive(join(handbookDir, 'stages'), { extensions: ['.md'] });
    for (const page of stagePages) {
      copyFileSync(join(handbookDir, 'stages', page), join(stagesDir, basename(page)));
    }
  } else {
    stagePages = listFilesRecursive(handbookDir, { extensions: ['.md'] }).filter((f) =>
      STAGE_PAGE_RE.test(basename(f)),
    );
    for (const page of stagePages) {
      copyFileSync(join(handbookDir, page), join(stagesDir, basename(page)));
    }
  }

  if (options.coverage) {
    const { assignment, sourceRoot } = options.coverage;
    const files = Object.entries(assignment.fileStage)
      .map(([file, entry]) => {
        let sha = '';
        if (sourceRoot) {
          try {
            sha = sha256Hex(readFileSync(join(sourceRoot, file)));
          } catch {
            sha = '';
          }
        }
        return { path: file, stage: entry.stage, sha256: sha };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    writeJsonFile(join(referencesDir, 'coverage.json'), {
      schemaVersion: 1,
      summary: {
        eligibleFiles: files.length,
        stages: Object.fromEntries(
          Object.entries(assignment.buckets).map(([sid, bucket]) => [sid, bucket.length]),
        ),
      },
      files,
    });
    references.push('coverage.json');
  }

  return { outDir, nStagePages: stagePages.length, references };
}

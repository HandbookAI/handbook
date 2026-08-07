#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible mock endpoint so the full CLI pipeline can run
 * offline against ANY repository. It answers every pipeline prompt with
 * deterministic, prompt-derived JSON — stages come from the directory rollup,
 * assignments from directory matching, so the structure always mirrors the
 * analyzed codebase.
 *
 * The PROSE it produces is canned placeholder text: this is a contract mock,
 * not a language model. Point OPENAI_BASE_URL at a real endpoint for real
 * narration.
 *
 * Usage:
 *   node examples/mock-llm-server.mjs [port]
 *   OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 OPENAI_API_KEY=EMPTY handbook generate …
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8090);

/** Group a DIRECTORY by its first two segments: `packages/core/src` → `packages/core`, `app` → `app`. */
function groupOfDir(dir) {
  if (!dir || dir === '.') return '.';
  return dir.split('/').slice(0, 2).join('/');
}

/** Group a FILE path: drop the filename, then group its directory. */
function groupOfFile(path) {
  const i = path.lastIndexOf('/');
  return groupOfDir(i < 0 ? '.' : path.slice(0, i));
}

function titleCase(text) {
  return text.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Recognize a prompt by ANY of its language variants. The pipeline ships an
 * English and a Chinese rule text per prompt (`--narrate-lang zh`), while the
 * structural markers around them (`### FILE:`, the directory rollup, the stage
 * menu) are language-independent facts. Matching only the English wording made
 * every zh run fall through to the planner fallback and die at skeleton synthesis.
 */
function isPrompt(prompt, ...markers) {
  return markers.some((m) => prompt.includes(m));
}

function respond(prompt) {
  // 2a — file cards (brief or deep)
  if (
    isPrompt(
      prompt,
      'Files to describe',
      'processing a CHUNK',
      '你在逐个阅读源码文件',
      '你在完整阅读源码文件',
      '正在处理一个超长文件',
    )
  ) {
    const files = [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => m[1]);
    const purposes = files.map((file) => {
      const stem = file.split('/').pop();
      const role = /main|index|cli/.test(file) ? 'entrypoint' : /test/.test(file) ? 'test' : 'domain_logic';
      return {
        file,
        purpose: `Implements the ${stem} unit of this codebase.`,
        description:
          `This file (${file}) is one moving part of the system. ` +
          `It cooperates with its neighbors through direct calls and keeps its own state small. ` +
          `(Placeholder prose from the offline mock — use a real LLM endpoint for real narration.)`,
        functions: [...prompt.matchAll(/^ {2}- (\S+) {2}\(lines \d+-\d+\)/gm)].map((f) => ({
          qualname: f[1],
          purpose: `Performs the ${f[1]} step.`,
          data_flow: 'Takes its inputs, transforms them, returns the result.',
          relations: 'Called by its neighbors as recorded in the call graph.',
        })),
        role,
        lifecycle: /main|index|cli/.test(file) ? 'startup' : 'main loop',
      };
    });
    return { purposes };
  }

  // 2b — skeleton synthesis: one stage per directory group from the rollup.
  if (isPrompt(prompt, 'dividing a large codebase into the STAGES', '你在为一个代码库划分系统手册的')) {
    const dirs = [...prompt.matchAll(/^- (\S+) {2}\(\d+f\)/gm)].map((m) => m[1]);
    const groups = [...new Set(dirs.map(groupOfDir))].slice(0, 20);
    const stages = groups.map((dir, i) => ({
      id: `stage-${i + 1}`,
      // First segment is the meaningful name ('core/src' → 'Core', 'app' → 'App').
      title: dir === '.' ? 'Top-level files' : titleCase(dir.split('/')[0] ?? dir),
      description: `Everything under ${dir === '.' ? 'the repository root' : `${dir}/`}.`,
      parent: null,
      crosscut: false,
    }));
    if (stages.length === 0) {
      stages.push({
        id: 'stage-1',
        title: 'Codebase',
        description: 'All files.',
        parent: null,
        crosscut: false,
      });
    }
    return { metadata: { archetype: 'software codebase' }, stages };
  }

  // 2b — file assignment: match a file's directory group against the stage menu.
  if (prompt.includes('assigning whole SOURCE FILES')) {
    const menu = [
      ...prompt.matchAll(/^- (stage-\d+|crosscut-\d+|\S+) — .*?Everything under (\S+?)\.?$/gm),
    ].map((m) => ({ id: m[1], dir: m[2].replace(/\/$/, '') }));
    const files = [...prompt.matchAll(/^- (\S+) {2}\(/gm)].map((m) => m[1]);
    const fallback = [...prompt.matchAll(/^- (stage-\d+)/gm)][0]?.[1] ?? 'unassigned';
    return {
      assignments: files.map((file) => {
        const group = groupOfFile(file);
        const hit =
          menu.find((s) => s.dir === group) ??
          menu.find((s) => s.dir === 'the repository root' && group === '.');
        return { file, stage: hit?.id ?? fallback, also: [] };
      }),
    };
  }

  // 2b — member classification (member strategy): round-robin over the menu.
  if (prompt.includes('assigning individual FUNCTIONS')) {
    const menuIds = [...prompt.matchAll(/^- (\S+) — /gm)].map((m) => m[1]);
    const members = [...prompt.matchAll(/^- (\S+)$/gm)].map((m) => m[1]);
    return {
      assignments: members.map((member, i) => ({
        member,
        stage: menuIds[i % Math.max(1, menuIds.length)] ?? 'unassigned',
      })),
    };
  }

  // doctor / critics
  if (prompt.includes('SKELETON DOCTOR')) return { changes: [], rationale: 'Healthy and fully covered.' };
  if (prompt.includes('Proposal under review')) {
    return { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'Sound.' };
  }

  // 2c — organization: one group, given order.
  if (isPrompt(prompt, 'organizing the files of ONE stage', '你在把系统手册中一个阶段的文件组织成可读结构')) {
    const files = [...prompt.matchAll(/^- (\S+?)(?: {2}\[|\n)/gm)].map((m) => m[1]);
    return {
      groups: [{ title: 'Core flow', summary: 'Everything this stage owns, in execution order.', files }],
    };
  }

  // 3 — registers: one generic shared-state register over the first two stages.
  if (isPrompt(prompt, 'STATE REGISTERS', '找出这个系统的')) {
    const stageIds = [...prompt.matchAll(/^- (\S+) · /gm)].map((m) => m[1]).slice(0, 2);
    return {
      registers:
        stageIds.length > 0
          ? [
              {
                id: 'reg-shared-config',
                semantics: 'Configuration shared across the main stages (placeholder from the offline mock).',
                stages: stageIds,
              },
            ]
          : [],
    };
  }
  if (isPrompt(prompt, 'COMPLETING a list of state registers', '你在补全状态寄存器清单'))
    return { registers: [] };
  if (isPrompt(prompt, '为下面每个状态寄存器标注')) return { registers: [] };

  // 3 — narration (prose, not JSON)
  if (isPrompt(prompt, 'writing the OVERVIEW for one stage', '现在写其中一个阶段的')) {
    const title =
      (prompt.match(/## Stage title: (.+)/) ?? prompt.match(/## 阶段标题[:：] *(.+)/))?.[1] ?? 'this stage';
    return (
      `The ${title} stage is one station on this system's assembly line: work arrives from the previous ` +
      `station, this stage does its one job, and the result moves on. Its files cooperate through the call ` +
      `relations recorded in the graph. (Placeholder prose from the offline mock — point the pipeline at a ` +
      `real LLM endpoint for real narration.)`
    );
  }
  if (isPrompt(prompt, 'top-level overview of a system handbook', '你在为普通读者撰写系统手册的顶层总览')) {
    return (
      `This handbook was generated offline against a deterministic mock endpoint, so this overview is ` +
      `placeholder prose: the STRUCTURE around it — stages, file assignment, per-function call facts, ` +
      `registers — is real and derived from the analyzed codebase. Re-run generation against a real ` +
      `OpenAI-compatible endpoint to replace the prose with genuine narration.`
    );
  }

  // planner (agent loop) — not used by the demo scripts, but answer sanely.
  return { tool: 'finish', plan: 'No plan: mock server fallback.' };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let prompt = '';
    try {
      const parsed = JSON.parse(body);
      prompt = parsed.messages?.map((m) => m.content).join('\n') ?? '';
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    const answer = respond(prompt);
    const content =
      typeof answer === 'string' ? answer : '```json\n' + JSON.stringify(answer, null, 2) + '\n```';
    const send = () => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    };
    // MOCK_DELAY_MS makes every reply slow on purpose: it is how the studio's
    // cancel button and the pipeline's abort checkpoints get exercised by hand.
    const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);
    if (delayMs > 0) {
      const timer = setTimeout(send, delayMs);
      res.on('close', () => clearTimeout(timer)); // client aborted — stop pretending
    } else {
      send();
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock LLM listening on http://127.0.0.1:${port}/v1 (Ctrl-C to stop)`);
});

#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible mock endpoint so the full CLI pipeline can run
 * offline. It answers every pipeline prompt with deterministic, prompt-derived
 * JSON — the same contract a real model would follow.
 *
 * Usage:
 *   node examples/mock-llm-server.mjs [port]
 *   OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 OPENAI_API_KEY=EMPTY handbook generate …
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8090);

function respond(prompt) {
  // 2a — file cards
  if (prompt.includes('Files to describe') || prompt.includes('processing a CHUNK')) {
    const files = [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => m[1]);
    const purposes = files.map((file) => {
      const stem = file.split('/').pop();
      const role = file.includes('main') ? 'entrypoint' : file.endsWith('.sh') ? 'util' : 'domain_logic';
      return {
        file,
        purpose: `Implements the ${stem} part of the demo pipeline.`,
        description: `This file (${file}) is one moving part of the demo system. It plays the role of a ${role} and cooperates with its neighbors through direct function calls, keeping its own state small and predictable.`,
        functions: [...prompt.matchAll(/^ {2}- (\S+) {2}\(lines \d+-\d+\)/gm)].map((f) => ({
          qualname: f[1],
          purpose: `Does the ${f[1]} step.`,
          data_flow: 'Takes its inputs, transforms them, returns the result.',
          relations: 'Called by its stage neighbors as part of the demo flow.',
        })),
        role,
        lifecycle: file.includes('main') ? 'startup' : 'main loop',
      };
    });
    return { purposes };
  }
  // 2b — skeleton synthesis
  if (prompt.includes('dividing a large codebase into the STAGES')) {
    return {
      metadata: { archetype: 'demo task runner' },
      stages: [
        { id: 'stage-1', title: 'Startup', description: 'Entry point: builds the queue and worker, then starts the run.', parent: null, crosscut: false },
        { id: 'stage-2', title: 'Task execution', description: 'The queue and the worker that drains it.', parent: null, crosscut: false },
        { id: 'stage-3', title: 'Status reporting', description: 'Dashboard status rendering.', parent: null, crosscut: false },
        { id: 'crosscut-1', title: 'Operations scripts', description: 'Deploy and maintenance shell scripts.', parent: null, crosscut: true },
      ],
    };
  }
  // 2b — file assignment
  if (prompt.includes('assigning whole SOURCE FILES')) {
    const files = [...prompt.matchAll(/^- (\S+) {2}\(/gm)].map((m) => m[1]);
    return {
      assignments: files.map((file) => ({
        file,
        stage: file.includes('main')
          ? 'stage-1'
          : file.endsWith('.ts')
            ? 'stage-3'
            : file.endsWith('.sh')
              ? 'crosscut-1'
              : 'stage-2',
        also: [],
      })),
    };
  }
  // 2b — member classification (member strategy)
  if (prompt.includes('assigning individual FUNCTIONS')) {
    const members = [...prompt.matchAll(/^- (\S+)$/gm)].map((m) => m[1]);
    return { assignments: members.map((member) => ({ member, stage: member.includes('main') ? 'stage-1' : 'stage-2' })) };
  }
  // doctor / critics
  if (prompt.includes('SKELETON DOCTOR')) return { changes: [], rationale: 'Healthy and fully covered.' };
  if (prompt.includes('Proposal under review')) {
    return { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'Sound.' };
  }
  // 2c — organization
  if (prompt.includes('organizing the files of ONE stage')) {
    const files = [...prompt.matchAll(/^- (\S+?)(?: {2}\[|\n)/gm)].map((m) => m[1]);
    return { groups: [{ title: 'Core flow', summary: 'Everything this stage owns, in execution order.', files }] };
  }
  // 3 — registers
  if (prompt.includes('STATE REGISTERS')) {
    return {
      registers: [
        { id: 'reg-task-queue', semantics: 'The FIFO list of pending tasks, pushed at startup and drained by the worker.', stages: ['stage-1', 'stage-2'] },
        { id: 'reg-status-history', semantics: 'Recorded status lines shown on the dashboard.', stages: ['stage-3'] },
      ],
    };
  }
  if (prompt.includes('COMPLETING a list of state registers')) return { registers: [] };
  // 3 — narration (prose, not JSON)
  if (prompt.includes('writing the OVERVIEW for one stage')) {
    const title = prompt.match(/## Stage title: (.+)/)?.[1] ?? 'this stage';
    return `The ${title} stage is one link in the demo's chain. Think of it as a station on a small assembly line: work arrives from the previous station, this stage does its one job well, and the result moves on. Its files cooperate through plain function calls, and the state they share is deliberately small so a newcomer can trace any task from entry to completion without surprises.`;
  }
  if (prompt.includes('top-level overview of a system handbook')) {
    return `This demo system is a miniature task runner. At startup the entry point builds a queue, seeds it with work, and hands it to a worker. The worker drains the queue one task at a time, executing each and counting what it finished. A small dashboard module renders one-line status reports, and a deploy script handles operations chores. Everything communicates through direct calls and two small pieces of shared state — the task queue itself and the status history — which makes the whole lifecycle easy to follow from push to report.`;
  }
  // planner (agent loop) — not used by run-demo, but answer sanely.
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
    const content = typeof answer === 'string' ? answer : '```json\n' + JSON.stringify(answer, null, 2) + '\n```';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock LLM listening on http://127.0.0.1:${port}/v1 (Ctrl-C to stop)`);
});

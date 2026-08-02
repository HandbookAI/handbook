/**
 * The handbook planner: a single read-only agent that routes with a handbook,
 * reads the real source, and emits a precise edit plan.
 *
 * The agent loop uses a plain single-turn {@link ChatClient} — the whole
 * transcript is re-sent each turn as one prompt. That keeps the planner
 * compatible with ANY OpenAI-compatible endpoint (no function-calling API
 * required) and trivially scriptable with MockChatClient in tests.
 */
import { join } from 'node:path';
import type { ChatClient } from '@handbook/llm';
import { silentLogger, truncate, type Logger } from '@handbook/core';
import { ReadOnlyTools } from './tools.js';
import { DEFAULT_PROMPT_VARS, TOOL_PROTOCOL, buildPlannerSystemPrompt, type PlannerPromptVars } from './prompt.js';

export interface PlannerOptions {
  client: ChatClient;
  /** Root of the codebase to plan against (read-only). */
  sourceRoot: string;
  /** Rendered handbook or skill directory; exposed to the agent under `__handbook__/`. */
  handbookDir?: string;
  /** The natural-language change request. */
  request: string;
  promptVars?: Partial<PlannerPromptVars>;
  /** Maximum agent turns before forced finish. Default 30. */
  maxTurns?: number;
  logger?: Logger;
}

export interface Declarations {
  willModify: string[];
  willAdd: string[];
  willRemove: string[];
}

export interface PlannerResult {
  plan: string;
  declarations?: Declarations;
  turns: number;
  /** One line per tool call, for tracing. */
  trace: string[];
}

interface Action {
  tool: string;
  path?: string;
  pattern?: string;
  start_line?: number;
  end_line?: number;
  plan?: string;
}

const HANDBOOK_MOUNT = '__handbook__';
const MAX_RESULT_CHARS = 50_000;

export function parseDeclarations(plan: string): Declarations | undefined {
  const blocks = [...plan.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last) as Record<string, unknown>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    if (!('will_modify' in parsed) && !('will_add' in parsed) && !('will_remove' in parsed)) return undefined;
    return {
      willModify: list(parsed.will_modify),
      willAdd: list(parsed.will_add),
      willRemove: list(parsed.will_remove),
    };
  } catch {
    return undefined;
  }
}

export async function runPlanner(options: PlannerOptions): Promise<PlannerResult> {
  const logger = options.logger ?? silentLogger;
  const maxTurns = options.maxTurns ?? 30;
  const vars = { ...DEFAULT_PROMPT_VARS, ...options.promptVars };
  const sourceTools = new ReadOnlyTools(options.sourceRoot);
  const handbookTools = options.handbookDir ? new ReadOnlyTools(options.handbookDir) : undefined;

  const systemPrompt = buildPlannerSystemPrompt(vars) + TOOL_PROTOCOL;
  const handbookNote = handbookTools
    ? `A handbook for this codebase is mounted at \`${HANDBOOK_MOUNT}/\` — start by listing it and reading its index.`
    : 'No handbook is available — explore the source directly.';

  const transcript: string[] = [
    systemPrompt,
    `## Change request\n${options.request}\n\n${handbookNote}`,
  ];
  const trace: string[] = [];

  const runTool = (action: Action): string => {
    const path = action.path ?? '.';
    const inHandbook = handbookTools && (path === HANDBOOK_MOUNT || path.startsWith(`${HANDBOOK_MOUNT}/`));
    const tools = inHandbook ? handbookTools : sourceTools;
    const localPath = inHandbook ? path.slice(HANDBOOK_MOUNT.length).replace(/^\//, '') || '.' : path;
    switch (action.tool) {
      case 'list_dir':
        return tools.listDir(localPath).content;
      case 'read_file':
        return tools.readFile(localPath, action.start_line, action.end_line).content;
      case 'grep':
        return tools.grep(action.pattern ?? '', localPath).content;
      default:
        return `unknown tool "${action.tool}" — valid: list_dir, read_file, grep, finish`;
    }
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const isLast = turn === maxTurns;
    const prompt = isLast
      ? `${transcript.join('\n\n---\n\n')}\n\n---\n\nTurn limit reached. You MUST respond with the "finish" action now, containing your best complete plan.`
      : transcript.join('\n\n---\n\n');
    const response = await options.client.complete(prompt, { temperature: 0 });
    const action = (response.json ?? undefined) as Action | undefined;
    const looksLikePlan = response.text.includes('### EDIT');

    // A prose reply containing EDIT blocks IS the plan — even if some fenced
    // json inside it happens to parse as a non-finish "action" (e.g. an edit
    // about this very tool protocol). Only an explicit finish wins over that.
    if (!action || typeof action.tool !== 'string' || (looksLikePlan && action.tool !== 'finish')) {
      if (looksLikePlan || isLast) {
        const plan = response.text.trim();
        return { plan, declarations: parseDeclarations(plan), turns: turn, trace };
      }
      transcript.push(response.text, 'Your reply was not a valid action block. Respond with exactly one JSON action.');
      continue;
    }

    if (action.tool === 'finish') {
      const plan = (action.plan ?? '').trim() || response.text.trim();
      logger.info(`[planner] finished after ${turn} turns`);
      return { plan, declarations: parseDeclarations(plan), turns: turn, trace };
    }

    const result = runTool(action);
    trace.push(`${action.tool}(${truncate(action.pattern ?? action.path ?? '', 80)})`);
    logger.debug(`[planner] turn ${turn}: ${trace.at(-1)}`);
    transcript.push(
      `\`\`\`json\n${JSON.stringify(action)}\n\`\`\``,
      `## Tool result (${action.tool})\n${truncate(result, MAX_RESULT_CHARS)}`,
    );
  }

  return { plan: '(planner reached the turn limit without finishing)', turns: maxTurns, trace };
}

/** Convenience: mount a skill directory (references/) as the planner handbook. */
export function handbookDirFromSkill(skillDir: string): string {
  return join(skillDir, 'references');
}

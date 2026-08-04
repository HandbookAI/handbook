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
  /**
   * Set when the loop gave up instead of producing a plan. Callers MUST treat this
   * as a failure: a run that abandoned the request used to return normally, so the
   * job above it reported success while its own log said "rejected (3/3)".
   */
  aborted?: 'fabrication' | 'turn-limit' | 'no-plan';
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

/**
 * Close a plan's final code fence if the model forgot it.
 *
 * Observed: a complete, correct 2-edit plan was refused wholesale because the
 * trailing declarations block was missing its closing ```. The executor's
 * strictness is deliberate and must not be relaxed — a tolerated unclosed fence
 * is how a truncated anchor once slipped through — so the slip is repaired here,
 * where we can see it is a delimiter and not content: only ONE fence may be open,
 * and only at end of text. Anything else is left for the executor to refuse.
 */
export function closeDanglingFence(plan: string): { plan: string; repaired: boolean } {
  const lines = plan.split(/\r?\n/);
  let open: string | undefined;
  for (const line of lines) {
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const marker = m[1] as string;
    const info = (m[2] ?? '').trim();
    if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && info === '') open = undefined;
  }
  if (open === undefined) return { plan, repaired: false };
  return { plan: `${plan.replace(/\s*$/, '')}\n${open}\n`, repaired: true };
}

/** Repeated after the transcript every turn: the last thing read wins. */
const TURN_REMINDER =
  'Respond with EXACTLY ONE JSON action block and nothing else — no prose, no second action, ' +
  'and NEVER a "## Tool result" section (I write those, from tools I actually ran). ' +
  'If you already know enough, use the "finish" action with the complete plan in its "plan" field.';

/** Enough for one action, or a finish carrying a multi-edit plan. */
const PLANNER_MAX_TOKENS = 6000;

/** The harness's own result heading — a model writing it is fabricating. */
const FABRICATED_RESULT_RE = /^#{1,3}\s*Tool result\b/im;
/** How many fabricating replies to correct before giving up on the run. */
const MAX_FABRICATIONS = 3;

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
  /** Replies that invented tool results; a few are recoverable, a stream is not. */
  let fabricated = 0;

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
    // The reminder goes LAST, after the transcript. Put it only in the system
    // prompt and the final thing the model reads is a tool result — which is
    // exactly the shape it then starts imitating, generating tens of thousands of
    // characters of invented conversation until it hits the token cap.
    const prompt = isLast
      ? `${transcript.join('\n\n---\n\n')}\n\n---\n\nTurn limit reached. You MUST respond with the "finish" action now, containing your best complete plan.`
      : `${transcript.join('\n\n---\n\n')}\n\n---\n\n${TURN_REMINDER}`;
    // Say it BEFORE the call: a slow endpoint otherwise looks like a hang, and the
    // last line printed was the previous turn — which reads as "stuck at 2/30".
    logger.info(`[planner] turn ${turn}/${maxTurns}: asking the model…`);
    // One action block needs a few hundred tokens; a plan needs a few thousand.
    // Leaving the full budget open let a runaway reply burn 16k tokens per turn.
    const response = await options.client.complete(prompt, { temperature: 0, maxTokens: PLANNER_MAX_TOKENS });
    const action = (response.json ?? undefined) as Action | undefined;

    // A reply that writes the harness's own "## Tool result" heading has invented
    // file contents and is reasoning on top of them. Observed for real: one reply
    // contained 13 fabricated results and a plan built from a line that does not
    // exist in the file. Never accept it — not even the plan at the end of it,
    // because that plan was derived from fiction. Push back and ask again.
    if (FABRICATED_RESULT_RE.test(response.text)) {
      fabricated += 1;
      logger.warn(
        `[planner] turn ${turn}/${maxTurns}: reply invented tool results — rejected (${fabricated}/${MAX_FABRICATIONS})`,
      );
      if (fabricated >= MAX_FABRICATIONS) {
        return {
          plan:
            '(planner aborted: the model kept inventing tool results instead of reading the code. ' +
            'Nothing here is trustworthy — rerun, or point the planner at a stronger endpoint.)',
          turns: turn,
          trace,
          aborted: 'fabrication',
        };
      }
      transcript.push(
        'Your reply contained a "## Tool result" section. You do not write those — I do, and only for ' +
          'tools I actually ran. You were inventing file contents. Reply with EXACTLY one action block ' +
          'and nothing else.',
      );
      continue;
    }

    const looksLikePlan = response.text.includes('### EDIT');

    // A prose reply containing EDIT blocks IS the plan — even if some fenced
    // json inside it happens to parse as a non-finish "action" (e.g. an edit
    // about this very tool protocol). Only an explicit finish wins over that.
    if (!action || typeof action.tool !== 'string' || (looksLikePlan && action.tool !== 'finish')) {
      if (looksLikePlan || isLast) {
        const fixed = closeDanglingFence(response.text.trim());
        if (fixed.repaired) logger.warn('[planner] the plan left a code fence unclosed — closed it before returning');
        return { plan: fixed.plan, declarations: parseDeclarations(fixed.plan), turns: turn, trace };
      }
      transcript.push(response.text, 'Your reply was not a valid action block. Respond with exactly one JSON action.');
      continue;
    }

    if (action.tool === 'finish') {
      // Falling back to the raw reply here is how a 15 KB blob of invented
      // transcript once became "the plan". Only fall back when the reply at least
      // carries edit blocks; otherwise say plainly that nothing usable came back.
      const declared = (action.plan ?? '').trim();
      const noPlan = !declared && !looksLikePlan;
      const raw = declared || (looksLikePlan ? response.text.trim() : '(planner finished without producing a plan)');
      const fixed = closeDanglingFence(raw);
      if (fixed.repaired) logger.warn('[planner] the plan left a code fence unclosed — closed it before returning');
      const plan = fixed.plan;
      const nEdits = (plan.match(/^ {0,3}###\s+EDIT\s+\d+\s*$/gm) ?? []).length;
      logger.info(
        `[planner] finished after ${turn} turns — ${nEdits} edit block(s)` +
          (nEdits === 0 ? ' (the planner concluded no code change is needed)' : ''),
      );
      return { plan, declarations: parseDeclarations(plan), turns: turn, trace, ...(noPlan ? { aborted: 'no-plan' as const } : {}) };
    }

    const result = runTool(action);
    trace.push(`${action.tool}(${truncate(action.pattern ?? action.path ?? '', 80)})`);
    // The tool calls ARE the progress: someone watching a 30-turn agent loop needs
    // to see which files it opened and what it searched for, otherwise the whole
    // run looks like a single silent pause. `-q` still silences it.
    logger.info(`[planner] turn ${turn}/${maxTurns}: ${trace.at(-1)}`);
    transcript.push(
      `\`\`\`json\n${JSON.stringify(action)}\n\`\`\``,
      `## Tool result (${action.tool})\n${truncate(result, MAX_RESULT_CHARS)}`,
    );
  }

  return { plan: '(planner reached the turn limit without finishing)', turns: maxTurns, trace, aborted: 'turn-limit' };
}

/** Convenience: mount a skill directory (references/) as the planner handbook. */
export function handbookDirFromSkill(skillDir: string): string {
  return join(skillDir, 'references');
}

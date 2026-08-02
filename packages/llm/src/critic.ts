/**
 * Actor–critic orchestration: an actor LLM proposes a structured change, one
 * or more role-played critic LLMs review it against ground-truth evidence,
 * and the actor gets one revision round to address aggregated concerns.
 *
 * This module is deliberately domain-agnostic: the pipeline supplies the
 * actor prompt, the evidence block, and the proposal schema hint.
 */
import { mapLimit, type Logger, silentLogger } from '@handbook/core';
import type { ChatClient } from './client.js';

export type CriticDecision = 'APPROVE' | 'REVISE' | 'REJECT';

export interface Verdict {
  decision: CriticDecision;
  concerns: string[];
  suggestedRevision: unknown;
  rationale: string;
}

export type CriticRole = 'engineer' | 'architect' | 'reader' | 'editor';

/** Role-play framings for critics. Each reviews a different failure mode. */
export const ROLE_PROMPTS: Record<CriticRole, string> = {
  engineer: `You are a SENIOR ENGINEER reviewing a proposed change to a codebase handbook.
Be skeptical and look for real concerns rooted in code behavior: does the proposal match what the
code actually does, are the referenced items real and consistent, are boundaries and
caller/callee relationships respected?`,
  architect: `You are a SYSTEM ARCHITECT reviewing a proposed change to a codebase handbook.
Look for structural problems: unclear stage boundaries, bloated stages that should split,
starved stages that should merge, and misplaced cross-cutting concerns.`,
  reader: `You are a TECHNICAL WRITER reviewing a proposed change to a codebase handbook.
Ensure the change makes the handbook MORE readable: cohesive pages, intuitive titles and ids,
a narrative a newcomer can follow, and no surprising jumps.`,
  editor: `You are a NARRATIVE EDITOR reviewing a proposed ORDERING of items within one handbook
section. Check that the structure matches the content and reads as a story, not a directory listing.`,
};

const OUTPUT_RULES = `
## How to answer
- APPROVE generously: a correct-enough proposal is APPROVE, not REVISE.
- REVISE only for specific, actionable flaws that materially affect correctness or readability.
- REJECT only when the proposal is unfixable.
Return EXACTLY one JSON block:
\`\`\`json
{"decision": "APPROVE|REVISE|REJECT", "concerns": ["..."], "suggested_revision": null, "rationale": "..."}
\`\`\``;

/** Parse a critic response into a {@link Verdict}. Returns undefined on shape drift. */
export function parseVerdict(json: unknown): Verdict | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const v = json as Record<string, unknown>;
  const decision = typeof v.decision === 'string' ? v.decision.trim().toUpperCase() : '';
  if (decision !== 'APPROVE' && decision !== 'REVISE' && decision !== 'REJECT') return undefined;
  const suggested = v.suggested_revision ?? v.suggestedRevision ?? null;
  if (suggested !== null && typeof suggested !== 'object') return undefined;
  const concerns = Array.isArray(v.concerns) ? v.concerns.map(String) : [];
  let verdict: Verdict = {
    decision,
    concerns,
    suggestedRevision: suggested,
    rationale: typeof v.rationale === 'string' ? v.rationale : '',
  };
  // A REVISE with no concerns gives the actor nothing to act on — treat as APPROVE.
  if (verdict.decision === 'REVISE' && verdict.concerns.length === 0) {
    verdict = { ...verdict, decision: 'APPROVE', rationale: `[normalized vacuous REVISE] ${verdict.rationale}` };
  }
  return verdict;
}

export function buildCriticPrompt(args: {
  role: CriticRole;
  taskContext: string;
  proposal: unknown;
  schemaHint?: string;
  evidence?: string;
  roundNote?: string;
}): string {
  const parts = [ROLE_PROMPTS[args.role]];
  parts.push(`## Task context\n${args.taskContext}`);
  if (args.evidence) parts.push(`## Review evidence (ground truth for judgement)\n${args.evidence}`);
  if (args.roundNote) parts.push(`## Round context\n${args.roundNote}`);
  parts.push(`## Proposal under review\n\`\`\`json\n${JSON.stringify(args.proposal, null, 2)}\n\`\`\``);
  if (args.schemaHint) parts.push(`## Proposal schema reminder\n${args.schemaHint}`);
  parts.push(OUTPUT_RULES);
  return parts.join('\n\n');
}

export function buildRevisePrompt(args: {
  actorPrompt: string;
  originalProposal: unknown;
  concerns: string[];
  suggestedRevision?: unknown;
}): string {
  const parts = [
    args.actorPrompt,
    `── PREVIOUS PROPOSAL (under review) ──\n\`\`\`json\n${JSON.stringify(args.originalProposal, null, 2)}\n\`\`\``,
    `── REVIEWER'S CONCERNS ──\n${args.concerns.map((c) => `- ${c}`).join('\n')}`,
  ];
  if (args.suggestedRevision) {
    parts.push(
      `── REVIEWER'S SUGGESTED REVISION ──\n\`\`\`json\n${JSON.stringify(args.suggestedRevision, null, 2)}\n\`\`\``,
    );
  }
  parts.push('Address every concern above and return a corrected proposal in the SAME schema as before.');
  return parts.join('\n\n');
}

export interface ActorCriticOptions {
  roles?: CriticRole[];
  taskContext: string;
  schemaHint?: string;
  /** Ground-truth evidence block shared by actor revisions and critics. */
  evidence?: string;
  /** Revision rounds after the first review. Default 1. */
  maxReviseRounds?: number;
  /** Concurrent critic calls. Default = number of roles. */
  criticConcurrency?: number;
  temperature?: number;
  logger?: Logger;
}

export interface ActorCriticResult {
  /** Accepted proposal, or undefined when discarded/failed. */
  proposal: unknown | undefined;
  accepted: boolean;
  rounds: number;
  verdicts: Array<{ role: CriticRole; verdict: Verdict }>;
}

/**
 * Run one actor proposal through a parallel panel of critics, with at most
 * `maxReviseRounds` revision rounds.
 *
 * Rules (conservative by construction):
 * - all critics APPROVE → accept;
 * - any REJECT in the final round → discard;
 * - a critic whose call/parse fails counts as REJECT (a broken reviewer must
 *   not wave changes through);
 * - lingering REVISE after the last round ships the latest revision.
 */
export async function actorCriticLoop(
  client: ChatClient,
  actorPrompt: string,
  options: ActorCriticOptions,
): Promise<ActorCriticResult> {
  const roles = options.roles ?? ['engineer'];
  const logger = options.logger ?? silentLogger;
  const maxReviseRounds = options.maxReviseRounds ?? 1;
  const temperature = options.temperature ?? 0;

  const callActor = async (prompt: string): Promise<unknown | undefined> => {
    try {
      const result = await client.complete(prompt, { temperature });
      return typeof result.json === 'object' && result.json !== null ? result.json : undefined;
    } catch (error) {
      logger.warn(`actor call failed: ${String(error)}`);
      return undefined;
    }
  };

  const reviewOnce = async (
    proposal: unknown,
    roundNotes: Map<CriticRole, string>,
  ): Promise<Array<{ role: CriticRole; verdict: Verdict }>> =>
    mapLimit(roles, options.criticConcurrency ?? roles.length, async (role) => {
      try {
        const prompt = buildCriticPrompt({
          role,
          taskContext: options.taskContext,
          proposal,
          schemaHint: options.schemaHint,
          evidence: options.evidence,
          roundNote: roundNotes.get(role),
        });
        const result = await client.complete(prompt, { temperature });
        const verdict = parseVerdict(result.json);
        if (verdict) return { role, verdict };
        logger.warn(`critic ${role}: unparseable verdict — treating as REJECT`);
      } catch (error) {
        logger.warn(`critic ${role} failed: ${String(error)} — treating as REJECT`);
      }
      return {
        role,
        verdict: {
          decision: 'REJECT' as const,
          concerns: ['critic_call_failed'],
          suggestedRevision: null,
          rationale: 'critic call failed',
        },
      };
    });

  let proposal = await callActor(actorPrompt);
  if (proposal === undefined) return { proposal: undefined, accepted: false, rounds: 0, verdicts: [] };

  let rounds = 1;
  let verdicts = await reviewOnce(proposal, new Map());
  const allVerdicts = [...verdicts];

  for (let round = 0; round < maxReviseRounds; round += 1) {
    if (verdicts.every((v) => v.verdict.decision === 'APPROVE')) {
      return { proposal, accepted: true, rounds, verdicts: allVerdicts };
    }
    if (verdicts.some((v) => v.verdict.decision === 'REJECT')) {
      return { proposal: undefined, accepted: false, rounds, verdicts: allVerdicts };
    }
    const concerns = verdicts.flatMap((v) => v.verdict.concerns.map((c) => `[${v.role}] ${c}`));
    const suggested = verdicts.find((v) => v.verdict.suggestedRevision != null)?.verdict.suggestedRevision;
    const revised = await callActor(
      buildRevisePrompt({ actorPrompt, originalProposal: proposal, concerns, suggestedRevision: suggested }),
    );
    if (revised === undefined) return { proposal: undefined, accepted: false, rounds, verdicts: allVerdicts };
    proposal = revised;
    rounds += 1;
    const roundNotes = new Map<CriticRole, string>(
      verdicts.map((v) => [
        v.role,
        `This is round ${rounds}. Your previous verdict was ${v.verdict.decision} with concerns: ${
          v.verdict.concerns.join('; ') || '(none)'
        }. Judge whether the revision addresses them.`,
      ]),
    );
    verdicts = await reviewOnce(proposal, roundNotes);
    allVerdicts.push(...verdicts);
  }

  const rejected = verdicts.some((v) => v.verdict.decision === 'REJECT');
  return { proposal: rejected ? undefined : proposal, accepted: !rejected, rounds, verdicts: allVerdicts };
}

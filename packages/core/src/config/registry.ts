/**
 * The configuration registry: every setting, declared once.
 *
 * Four consumers read this table and nothing else — commander option
 * construction (`cli/src/options.ts`), value resolution (`resolve.ts`),
 * `.env.example` and `docs/configuration.md` (`render-docs.ts`). Adding a
 * setting is therefore a one-line change that shows up on all four surfaces,
 * or fails the build.
 */
import type { Setting } from './types.js';

/** Commands that talk to an LLM endpoint, and so take the whole llm* group. */
const LLM_COMMANDS = ['generate', 'plan', 'resync', 'studio'] as const;

export const SETTINGS: readonly Setting[] = [
  // ── global ────────────────────────────────────────────────────────────────
  {
    key: 'logLevel',
    type: 'enum',
    choices: ['debug', 'info', 'error'],
    default: 'info',
    commands: [
      'analyze',
      'generate',
      'render',
      'skill',
      'validate',
      'plan',
      'apply',
      'rollback',
      'resync',
      'studio',
      'config',
    ],
    doc: 'log verbosity; -v/--verbose and -q/--quiet are shorthand for debug/error',
  },

  // ── llm ───────────────────────────────────────────────────────────────────
  {
    key: 'llmApiKey',
    type: 'string',
    secret: true,
    default: '',
    envAliases: ['OPENAI_API_KEY'],
    commands: [...LLM_COMMANDS],
    example: 'sk-...',
    doc: 'API key for the LLM endpoint; use EMPTY for keyless local endpoints. Never a flag and never allowed in the config file',
  },
  {
    key: 'llmModel',
    type: 'string',
    flag: '--model <id>',
    default: 'gpt-4o-mini',
    envAliases: ['OPENAI_MODEL'],
    commands: [...LLM_COMMANDS],
    doc: 'model identifier',
  },
  {
    key: 'llmBaseUrl',
    type: 'string',
    flag: '--base-url <url>',
    default: 'https://api.openai.com/v1',
    envAliases: ['OPENAI_BASE_URL'],
    commands: [...LLM_COMMANDS],
    doc: 'any OpenAI-compatible endpoint (hosted, vLLM, LiteLLM, a proxy)',
  },
  {
    key: 'llmMaxTokens',
    type: 'int',
    min: 1,
    flag: '--max-tokens <n>',
    default: 16000,
    envAliases: ['OPENAI_MAX_TOKENS'],
    commands: [...LLM_COMMANDS],
    doc: 'max output tokens per request',
  },
  {
    key: 'llmTimeout',
    type: 'int',
    min: 1,
    flag: '--timeout <sec>',
    default: 300,
    envAliases: ['OPENAI_TIMEOUT'],
    commands: [...LLM_COMMANDS],
    doc: 'per-request deadline in seconds; a stalled call is retried rather than allowed to hold a phase hostage',
  },
  {
    key: 'llmMaxRetries',
    type: 'int',
    min: 0,
    flag: '--llm-retries <n>',
    default: 6,
    commands: [...LLM_COMMANDS],
    doc: 'retry attempts per request; 0 means a single attempt',
  },
  {
    key: 'llmRetryBackoff',
    type: 'int',
    min: 0,
    flag: '--llm-retry-backoff <sec>',
    default: 3,
    commands: [...LLM_COMMANDS],
    doc: 'base backoff between retries, in seconds',
  },
  {
    key: 'llmConcurrency',
    type: 'int',
    min: 1,
    flag: '--llm-concurrency <n>',
    default: 16,
    commands: [...LLM_COMMANDS],
    doc: 'global cap on concurrent requests through one client',
  },
  {
    key: 'llmExtraBody',
    type: 'json',
    flag: '--extra-body <json>',
    envAliases: ['OPENAI_EXTRA_BODY'],
    commands: [...LLM_COMMANDS],
    example: '{"thinking":{"type":"disabled"}}',
    doc: 'vendor fields merged into every request body; model/messages/token fields cannot be overridden',
  },
];

export function settingsFor(command: string): readonly Setting[] {
  return SETTINGS.filter((s) => s.commands.includes(command));
}

export function settingByKey(key: string): Setting | undefined {
  return SETTINGS.find((s) => s.key === key);
}

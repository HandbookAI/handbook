/**
 * One declarative table describes every setting exactly once, and the CLI
 * options, the environment variables, the config file, `.env.example` and the
 * reference docs are all derived from it.
 *
 * The alternative is what this repo already had: each switch wired where it was
 * needed, which left exactly one of ~45 flags (`--title`) also settable from the
 * environment, no flags at all for the LLM endpoint, and six real pipeline
 * fields reachable from neither.
 */
export type SettingType = 'string' | 'int' | 'bool' | 'enum' | 'path' | 'json';

export interface Setting {
  /** camelCase identity. Derives the env name, the config-file key and the resolved property. */
  readonly key: string;
  readonly type: SettingType;
  /** Commander flag spec, e.g. `--read-workers <n>`. Absent = not settable on the command line. */
  readonly flag?: string;
  /** Subcommands this setting applies to. */
  readonly commands: readonly string[];
  /** One line, English. Goes verbatim into `--help`, `.env.example` and the docs. */
  readonly doc: string;
  /**
   * Value used when no layer supplies one. `undefined` means *pass through*:
   * the key is omitted from the resolved object entirely so a downstream
   * default (e.g. the pipeline's own) still applies.
   */
  readonly default?: string | number | boolean;
  /** Required for `int`. */
  readonly min?: number;
  /** Required for `enum`. */
  readonly choices?: readonly string[];
  /** Additional accepted env names, for vendor standards like `OPENAI_MODEL`. */
  readonly envAliases?: readonly string[];
  /** Semantics differ per command (`--out`, `--lang`): register only the scoped name. */
  readonly scopedOnly?: boolean;
  /** Never a flag, never allowed in the config file (it gets committed). */
  readonly secret?: boolean;
  /** Commander maps `--no-llm` to `{ llm: false }`; the flag string is the negated one. */
  readonly negated?: boolean;
  /** Must have a value after resolution; the error names all supply routes. */
  readonly required?: boolean;
  /**
   * Commands where this setting is required, when it is not required for all of
   * them. `source` is mandatory for analyze/generate/plan/apply and optional
   * for validate/skill/rollback — one setting, because it is one concept.
   */
  readonly requiredFor?: readonly string[];
  /** Placeholder shown in `.env.example` when there is no default to show. */
  readonly example?: string;
  /**
   * Choices that cannot be written down here because they come from a registry
   * at runtime — `languages` means "auto plus every registered adapter". The
   * `--lang` help text had already drifted five languages behind by being
   * hand-written once.
   */
  readonly dynamicChoices?: 'languages';
}

/** Where a resolved value came from. Surfaced by `handbook config`. */
export type Source =
  | { readonly kind: 'flag'; readonly name: string }
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string; readonly keyPath: string }
  | { readonly kind: 'default' };

export interface ResolveResult {
  /** Only the keys that resolved. Pass-through settings are absent when unset. */
  readonly values: Record<string, unknown>;
  readonly sources: Record<string, Source>;
  /** Every problem found, not just the first — `config --check` prints them all. */
  readonly errors: readonly string[];
}

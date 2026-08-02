/** Error taxonomy shared across packages. */

/** Base class for all handbook errors. */
export class HandbookError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HandbookError';
    this.code = code;
  }
}

/** A prerequisite artifact is missing (e.g. run phase 1 before phase 2). */
export class MissingArtifactError extends HandbookError {
  constructor(what: string, hint?: string) {
    super('MISSING_ARTIFACT', hint ? `${what} not found — ${hint}` : `${what} not found`);
    this.name = 'MissingArtifactError';
  }
}

/** A persisted artifact failed schema validation. */
export class ArtifactValidationError extends HandbookError {
  constructor(path: string, detail: string) {
    super('ARTIFACT_INVALID', `invalid artifact ${path}: ${detail}`);
    this.name = 'ArtifactValidationError';
  }
}

/** An error that must not be retried (e.g. HTTP 400/401/404 from an LLM endpoint). */
export class PermanentError extends HandbookError {
  constructor(message: string, options?: ErrorOptions) {
    super('PERMANENT', message, options);
    this.name = 'PermanentError';
  }
}

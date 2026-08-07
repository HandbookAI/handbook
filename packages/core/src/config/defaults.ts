/**
 * Pipeline tuning defaults, in one place.
 *
 * These numbers used to live only in the downstream destructuring
 * (`const { batchSize = 25 } = options`), which meant the registry documenting
 * them would have been a second source of truth for the same value — and the
 * generated docs would drift from behaviour the moment either moved. Both the
 * registry and the pipeline now read these.
 */
export const PIPELINE_DEFAULTS = {
  /** Files per card batch. `generate` overrides to 1 when --detail deep. */
  readBatchSize: 8,
  readWorkers: 12,
  /** 0 = no truncation. */
  maxCharsPerFile: 0,
  assignBatchSize: 25,
  assignWorkers: 12,
  organizeWorkers: 8,
  narrateWorkers: 8,
  maxDoctorRounds: 6,
} as const;

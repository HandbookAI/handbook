import type { Logger } from '../logger.js';

/** Format a duration in seconds as `12s`, `3m05s`, or `1h02m`. */
export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Linear-extrapolation progress reporter for long-running batched passes.
 * Logs `[label done/total · P%] note · elapsed E · ETA T` on every tick.
 */
export class Progress {
  private done = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly logger: Logger,
    private readonly label: string,
    private readonly total: number,
  ) {}

  tick(weight = 1, note = ''): void {
    this.done += weight;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const pct = this.total > 0 ? Math.round((this.done / this.total) * 100) : 100;
    const eta = this.done > 0 ? fmtDuration((elapsed / this.done) * (this.total - this.done)) : '?';
    const suffix = note ? ` ${note} ·` : '';
    this.logger.info(
      `[${this.label} ${this.done}/${this.total} · ${pct}%]${suffix} elapsed ${fmtDuration(elapsed)} · ETA ${eta}`,
    );
  }

  finish(unit = 'item'): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    this.logger.info(`[${this.label} done] ${this.done} ${unit}(s) in ${fmtDuration(elapsed)}`);
  }
}

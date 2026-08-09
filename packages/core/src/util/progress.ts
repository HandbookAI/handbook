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
 * One machine-readable progress update.
 *
 * The log line a `Progress` already prints is for a person reading a terminal.
 * A UI needs the numbers, not the sentence — and it needs them for the WHOLE
 * run, which no single pass can know on its own. Hence `overall`, filled in by
 * whoever is tracking the run (see `RunProgress`) rather than by the pass.
 */
export interface ProgressEvent {
  /** The pass emitting this: `cards`, `assign`, `organize`, `narrate`, … */
  scope: string;
  done: number;
  total: number;
  /** 0-100 for this pass. */
  pct: number;
  elapsedSec: number;
  /** Remaining seconds for this pass, by linear extrapolation; undefined before the first tick. */
  etaSec?: number;
  note?: string;
  /**
   * Progress across the whole run, when a `RunProgress` is tracking one.
   *
   * `phase` is the coarse, always-correct figure: which of the planned phases
   * is running. `done`/`total` are units of real work, and their denominator
   * GROWS as later passes announce their own totals — a card pass cannot know
   * how many stages phase 2b will invent. A UI should lead with the phase and
   * use the units as the fine-grained bar.
   */
  overall?: {
    done: number;
    total: number;
    pct: number;
    etaSec?: number;
    phase?: { index: number; count: number; name: string };
  };
}

export type ProgressSink = (event: ProgressEvent) => void;

/**
 * Linear-extrapolation progress reporter for long-running batched passes.
 * Logs `[label done/total · P%] note · elapsed E · ETA T` on every tick, and —
 * when given a sink — emits the same numbers for a UI to draw.
 */
export class Progress {
  private done = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly logger: Logger,
    private readonly label: string,
    private readonly total: number,
    private readonly sink?: ProgressSink,
  ) {
    // Announce the pass at 0% so a bar can appear before the first slow batch
    // finishes, rather than after it.
    this.sink?.({ scope: label, done: 0, total, pct: 0, elapsedSec: 0 });
  }

  tick(weight = 1, note = ''): void {
    this.done += weight;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const pct = this.total > 0 ? Math.round((this.done / this.total) * 100) : 100;
    const etaSec = this.done > 0 ? (elapsed / this.done) * (this.total - this.done) : undefined;
    const suffix = note ? ` ${note} ·` : '';
    this.logger.info(
      `[${this.label} ${this.done}/${this.total} · ${pct}%]${suffix} elapsed ${fmtDuration(elapsed)} · ETA ${etaSec === undefined ? '?' : fmtDuration(etaSec)}`,
    );
    this.sink?.({
      scope: this.label,
      done: this.done,
      total: this.total,
      pct,
      elapsedSec: elapsed,
      etaSec,
      note: note || undefined,
    });
  }

  finish(unit = 'item'): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    this.logger.info(`[${this.label} done] ${this.done} ${unit}(s) in ${fmtDuration(elapsed)}`);
    this.sink?.({
      scope: this.label,
      done: this.total,
      total: this.total,
      pct: 100,
      elapsedSec: elapsed,
      etaSec: 0,
    });
  }
}

/**
 * Progress across a whole generate run, reported two ways because neither one
 * is honest on its own.
 *
 * **Phase** (`overall.phase`) is coarse and always correct: which of the
 * planned phases is running. It never moves backwards.
 *
 * **Units** (`overall.done`/`total`) are real work — files described, stages
 * organised — and their denominator GROWS as the run proceeds, because a card
 * pass genuinely cannot know how many stages phase 2b is about to invent. A
 * growing denominator looks odd for a moment; a fixed one would be a number
 * made up in advance.
 *
 * The tempting alternative — five phases, twenty percent each — claims a fifth
 * of the run for phase 1, which finishes in seconds on a repository where
 * phase 2a takes an hour. That is not a progress bar, it is a decoration.
 */
export class RunProgress {
  private readonly totals = new Map<string, number>();
  private readonly done = new Map<string, number>();
  private readonly startedAt = Date.now();

  private currentScope?: string;

  constructor(
    private readonly sink?: ProgressSink,
    /** The phases this run will execute, in order — the coarse bar's denominator. */
    private readonly phases: readonly string[] = [],
  ) {}

  /** Mark which phase is running, for the coarse bar. */
  enterPhase(name: string): void {
    this.currentScope = name;
  }

  /** Declare how many units a pass will process, once that is known. */
  expect(scope: string, total: number): void {
    this.totals.set(scope, Math.max(0, total));
  }

  get total(): number {
    let sum = 0;
    for (const n of this.totals.values()) sum += n;
    return sum;
  }

  get completed(): number {
    let sum = 0;
    for (const [scope, n] of this.done) sum += Math.min(n, this.totals.get(scope) ?? n);
    return sum;
  }

  /** A sink for one pass: records its progress and forwards it with the overall figure attached. */
  sinkFor(scope: string): ProgressSink {
    return (event) => {
      this.done.set(scope, event.done);
      // Only claim a total once the pass has declared one; an unregistered pass
      // contributes its units the moment it starts rather than distorting the
      // denominator retroactively.
      if (!this.totals.has(scope) && event.total > 0) this.totals.set(scope, event.total);
      const total = this.total;
      const completed = this.completed;
      const elapsed = (Date.now() - this.startedAt) / 1000;
      const phaseName = this.currentScope ?? scope;
      const index = this.phases.indexOf(phaseName);
      this.sink?.({
        ...event,
        overall: {
          done: completed,
          total,
          pct: total > 0 ? Math.round((completed / total) * 100) : 0,
          etaSec:
            completed > 0 && total > completed ? (elapsed / completed) * (total - completed) : undefined,
          ...(this.phases.length > 0
            ? { phase: { index: index >= 0 ? index + 1 : 0, count: this.phases.length, name: phaseName } }
            : {}),
        },
      });
    };
  }
}

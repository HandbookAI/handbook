/**
 * In-process job runner: generation/plan/resync run as background jobs with a
 * captured log (served over SSE) and a JSON-serializable result. One job per
 * repo at a time — the pipeline's artifacts are not safe for concurrent
 * writers on the same work dir.
 */
import { randomUUID } from 'node:crypto';
import type { Logger, ProgressEvent } from '@handbooks/core';

export type JobKind = 'analyze' | 'generate' | 'render' | 'skill' | 'plan' | 'resync' | 'apply' | 'rollback';
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Longest log LINE kept, in characters.
 *
 * The line cap matters as much as the line count. A model that answers a
 * request for one sentence with a megabyte of JSON produces one log line, and
 * the pipeline reports an unparseable reply by quoting it — so a 2000-line
 * buffer is only bounded if each line is. The buffer is held for the life of
 * the process and replayed in full to every SSE subscriber.
 */
const MAX_LINE_CHARS = 2_000;
/** Log lines kept per job; older ones fall off the front. */
const MAX_LOG_LINES = 2_000;
/**
 * Jobs allowed to run at once, across all repos.
 *
 * The per-repo mutex bounds writers on one work dir and nothing else. Each
 * generate holds a whole call graph and a tree-sitter grammar in memory while
 * fanning out LLM calls, and the UI makes starting one per repo a single click
 * each — so without a ceiling the honest outcome is an out-of-memory kill that
 * takes every running job with it.
 */
const DEFAULT_MAX_CONCURRENT_JOBS = 4;

/**
 * A refusal that already knows its HTTP status.
 *
 * "Too many jobs" is a capacity answer (429, try again), not a malformed
 * request (400, fix your input) — and the router has no other way to tell the
 * two apart once the error is a bare `Error`.
 */
export class JobCapacityError extends Error {
  readonly status = 429;
}

/** Cut a runaway line down to size, saying so rather than silently eliding. */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} more characters truncated]`;
}

export interface Job {
  id: string;
  repo: string;
  kind: JobKind;
  status: JobStatus;
  log: string[];
  result?: unknown;
  error?: string;
  /**
   * The most recent progress update, so a page that reloads mid-run can draw
   * the bar immediately instead of waiting for the next tick — which on a slow
   * batch can be minutes away.
   */
  progress?: ProgressEvent;
  /**
   * Whether this run can actually observe a cancellation.
   *
   * Cancellation here is cooperative: it works only where the run checks the
   * signal. `render`, `skill`, `apply` and `rollback` are synchronous work that
   * never yields, so a cancel used to be accepted with `202 {ok:true}`, keep
   * running to completion, and come back `succeeded` — a request answered with
   * the opposite of what happened. Saying so up front is the honest version.
   */
  cancellable: boolean;
  startedAt: string;
  endedAt?: string;
}

type Listener = (line: string, done: boolean, progress?: ProgressEvent) => void;

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly busyRepos = new Set<string>();
  /** Controllers for RUNNING jobs only — dropped the moment a job finishes. */
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT_JOBS) {}

  /**
   * Start a job. Throws when the repo already has a running job, or when the
   * global cap is reached (a `JobCapacityError`).
   */
  start(
    repo: string,
    kind: JobKind,
    work: (logger: Logger, signal: AbortSignal, onProgress: (e: ProgressEvent) => void) => Promise<unknown>,
    options: { debug?: boolean; cancellable?: boolean } = {},
  ): Job {
    if (this.busyRepos.has(repo)) {
      throw new Error(`repo "${repo}" already has a running job`);
    }
    // Counted from busyRepos rather than from the job map: one entry per running
    // job is exactly the invariant the per-repo mutex already maintains.
    if (this.busyRepos.size >= this.maxConcurrent) {
      throw new JobCapacityError(
        `studio runs at most ${this.maxConcurrent} jobs at once — wait for one to finish, or cancel it`,
      );
    }
    const job: Job = {
      id: randomUUID(),
      repo,
      kind,
      status: 'running',
      log: [],
      cancellable: options.cancellable !== false,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.busyRepos.add(repo);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    const emit = (raw: string, done = false): void => {
      const line = capLine(raw);
      job.log.push(line);
      if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
      for (const listener of this.listeners.get(job.id) ?? []) {
        try {
          listener(line, done);
        } catch {
          // a dead subscriber must not kill the job chain
        }
      }
    };

    /** Progress travels beside the log, not inside it: a bar is not a sentence. */
    const onProgress = (event: ProgressEvent): void => {
      job.progress = event;
      for (const listener of this.listeners.get(job.id) ?? []) {
        try {
          listener('', false, event);
        } catch {
          // a dead subscriber must not kill the job chain
        }
      }
    };
    const logger: Logger = {
      // Off unless asked for: debug is the pipeline narrating every batch, which
      // would drown the drawer. `logLevel: debug` on the job request enables it —
      // the registry setting used to be accepted and then ignored here.
      debug: options.debug ? (m) => emit(`· ${m}`) : () => {},
      info: (m) => emit(m),
      warn: (m) => emit(`⚠ ${m}`),
      error: (m) => emit(`✖ ${m}`),
      child: () => logger,
    };

    // Evict old finished jobs so a long-running studio doesn't grow forever.
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const old of finished.slice(0, Math.max(0, finished.length - 100))) this.jobs.delete(old.id);

    // Promise.resolve() guard: a synchronously-throwing work fn must still
    // flow into the cleanup chain instead of wedging busyRepos.
    void Promise.resolve()
      .then(() => work(logger, controller.signal, onProgress))
      .then((result) => {
        job.result = result;
        // A run that RESOLVED after the cancel is not a success. Either the work
        // finished in the race before the signal was observed, or it observed
        // nothing and played out to the end — and the second is the shape that
        // matters: the pipeline once let a cancelled doctor round read as
        // "healthy", so a cancelled generate wrote its manifest and came back
        // green. Reporting that as succeeded tells the user their cancel worked
        // AND that the run is good, so they never learn it did neither. The
        // result is kept and the log says what happened; the STATUS refuses to
        // claim a run the user stopped.
        if (controller.signal.aborted) {
          job.status = 'cancelled';
          emit('[job] cancelled — the work finished or stopped after the cancel; this run is not a success');
          return;
        }
        job.status = 'succeeded';
      })
      .catch((error: unknown) => {
        // An abort WE requested is an outcome, not an error: the run stopped at
        // its next checkpoint because the user asked it to. Any other rejection
        // — including a stray AbortError nobody requested — stays a failure.
        if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') {
          job.status = 'cancelled';
          emit('[job] cancelled by user');
        } else {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          emit(`✖ ${job.error}`);
        }
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
        this.controllers.delete(job.id);
        this.busyRepos.delete(repo);
        emit(`— ${job.kind} ${job.status} —`, true);
        this.listeners.delete(job.id);
      });

    return job;
  }

  /**
   * Request cooperative cancellation of a RUNNING job. Returns false for
   * unknown or already-finished jobs. The job does not end here — it ends
   * when the run observes the signal and rejects with an AbortError.
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    const controller = this.controllers.get(id);
    if (!job || job.status !== 'running' || !controller) return false;
    // A run that cannot observe the signal must not be told it was cancelled.
    if (!job.cancellable) return false;
    controller.abort();
    return true;
  }

  isBusy(repo: string): boolean {
    return this.busyRepos.has(repo);
  }

  /** How many jobs may run at once, so a refusal can say the number. */
  get capacity(): number {
    return this.maxConcurrent;
  }

  /** Whether a further job would exceed the global cap. */
  isAtCapacity(): boolean {
    return this.busyRepos.size >= this.maxConcurrent;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Recent jobs, newest first. */
  list(repo?: string): Job[] {
    const all = [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return repo ? all.filter((j) => j.repo === repo) : all;
  }

  /** Subscribe to live log lines. Returns an unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }
}

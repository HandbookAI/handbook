/**
 * In-process job runner: generation/plan/resync run as background jobs with a
 * captured log (served over SSE) and a JSON-serializable result. One job per
 * repo at a time — the pipeline's artifacts are not safe for concurrent
 * writers on the same work dir.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@handbook/core';

export type JobKind = 'generate' | 'render' | 'skill' | 'plan' | 'resync' | 'apply' | 'rollback';
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  repo: string;
  kind: JobKind;
  status: JobStatus;
  log: string[];
  result?: unknown;
  error?: string;
  startedAt: string;
  endedAt?: string;
}

type Listener = (line: string, done: boolean) => void;

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly busyRepos = new Set<string>();
  /** Controllers for RUNNING jobs only — dropped the moment a job finishes. */
  private readonly controllers = new Map<string, AbortController>();

  /** Start a job. Throws when the repo already has a running job. */
  start(
    repo: string,
    kind: JobKind,
    work: (logger: Logger, signal: AbortSignal) => Promise<unknown>,
    options: { debug?: boolean } = {},
  ): Job {
    if (this.busyRepos.has(repo)) {
      throw new Error(`repo "${repo}" already has a running job`);
    }
    const job: Job = {
      id: randomUUID(),
      repo,
      kind,
      status: 'running',
      log: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.busyRepos.add(repo);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    const emit = (line: string, done = false): void => {
      job.log.push(line);
      if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
      for (const listener of this.listeners.get(job.id) ?? []) {
        try {
          listener(line, done);
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
      .then(() => work(logger, controller.signal))
      .then((result) => {
        job.status = 'succeeded';
        job.result = result;
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
    controller.abort();
    return true;
  }

  isBusy(repo: string): boolean {
    return this.busyRepos.has(repo);
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

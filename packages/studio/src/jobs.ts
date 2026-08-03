/**
 * In-process job runner: generation/plan/resync run as background jobs with a
 * captured log (served over SSE) and a JSON-serializable result. One job per
 * repo at a time — the pipeline's artifacts are not safe for concurrent
 * writers on the same work dir.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@handbook/core';

export type JobKind = 'generate' | 'render' | 'plan' | 'resync';
export type JobStatus = 'running' | 'succeeded' | 'failed';

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

  /** Start a job. Throws when the repo already has a running job. */
  start(repo: string, kind: JobKind, work: (logger: Logger) => Promise<unknown>): Job {
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

    const emit = (line: string, done = false): void => {
      job.log.push(line);
      if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
      for (const listener of this.listeners.get(job.id) ?? []) listener(line, done);
    };
    const logger: Logger = {
      debug: () => {},
      info: (m) => emit(m),
      warn: (m) => emit(`⚠ ${m}`),
      error: (m) => emit(`✖ ${m}`),
      child: () => logger,
    };

    void work(logger)
      .then((result) => {
        job.status = 'succeeded';
        job.result = result;
      })
      .catch((error: unknown) => {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        emit(`✖ ${job.error}`);
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
        this.busyRepos.delete(repo);
        emit(`— ${job.kind} ${job.status} —`, true);
        this.listeners.delete(job.id);
      });

    return job;
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

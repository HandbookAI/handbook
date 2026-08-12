/** The read side: whatever the rollups produced, served over HTTP. */
import { formatPoint, formatTable } from './format.js';

/** Status codes this server actually returns. */
export enum HttpStatus {
  Ok = 200,
  NotFound = 404,
  Unavailable = 503,
}

/** One aggregated reading, as the API exposes it. */
export interface Reading {
  metric: string;
  value: number;
  at: string;
}

/** A handler is a function, not a class — there is nothing to construct. */
export type Handler = (path: string) => Response;

export interface Response {
  status: HttpStatus;
  body: string;
}

/**
 * Holds the latest reading per metric and answers two routes. Deliberately no
 * history: this is the demo's read model, and a growing map would be the only
 * unbounded thing in it.
 */
export class ApiServer {
  private latest = new Map<string, Reading>();

  record(reading: Reading): void {
    this.latest.set(reading.metric, reading);
  }

  /** `/metrics` lists everything; `/metrics/<name>` answers for one. */
  handle(path: string): Response {
    if (path === '/metrics') {
      return { status: HttpStatus.Ok, body: formatTable([...this.latest.values()]) };
    }
    const name = path.startsWith('/metrics/') ? path.slice('/metrics/'.length) : '';
    const found = name ? this.latest.get(name) : undefined;
    if (!found) {
      // 404 rather than an empty 200: an absent metric and a metric that read
      // zero are different answers.
      return { status: HttpStatus.NotFound, body: `no such metric: ${name || '(none)'}` };
    }
    return { status: HttpStatus.Ok, body: formatPoint(found) };
  }

  known(): number {
    return this.latest.size;
  }
}

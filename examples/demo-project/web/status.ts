/** Renders a one-line status string for the dashboard. */
export function statusLine(done: number, pending: number): string {
  return `done=${done} pending=${pending}`;
}

export class StatusBoard {
  private history: string[] = [];

  record(done: number, pending: number): void {
    this.history.push(statusLine(done, pending));
  }

  latest(): string {
    return this.history[this.history.length - 1] ?? '(no status yet)';
  }
}

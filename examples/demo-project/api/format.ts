/** Text rendering for the API. No dependency on the server, so it stays testable alone. */
import type { Reading } from './server.js';

/** Trailing zeros dropped, because `1` reads better than `1.000` in a table. */
export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
}

export function formatPoint(reading: Reading): string {
  return `${reading.metric} ${formatValue(reading.value)} @${reading.at}`;
}

/** An empty table says so, rather than returning an empty string. */
export function formatTable(readings: readonly Reading[]): string {
  if (readings.length === 0) return '(no readings yet)';
  return readings
    .slice()
    .sort((a, b) => a.metric.localeCompare(b.metric))
    .map(formatPoint)
    .join('\n');
}

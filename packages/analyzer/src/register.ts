/** Register every built-in language adapter. Call once at startup. */
import { registerAdapter } from './adapter.js';
import { PythonAdapter } from './adapters/python.js';

let done = false;

export function registerBuiltinAdapters(): void {
  if (done) return;
  done = true;
  registerAdapter('python', () => new PythonAdapter());
}

/** Register every built-in language adapter. Call once at startup. */
import { registerAdapter } from './adapter.js';
import { PythonAdapter } from './adapters/python.js';
import { TypeScriptAdapter } from './adapters/typescript.js';
import { GoAdapter } from './adapters/go.js';
import { RustAdapter } from './adapters/rust.js';
import { ShellAdapter } from './adapters/shell.js';
import { createGenericAdapter, GENERIC_LANGUAGES } from './generic.js';

let done = false;

export function registerBuiltinAdapters(): void {
  if (done) return;
  done = true;
  registerAdapter('python', () => new PythonAdapter());
  registerAdapter('typescript', () => new TypeScriptAdapter());
  registerAdapter('go', () => new GoAdapter());
  registerAdapter('rust', () => new RustAdapter());
  registerAdapter('shell', () => new ShellAdapter());
  // The long tail: one config-driven engine, one declarative spec per language.
  for (const spec of GENERIC_LANGUAGES) {
    registerAdapter(spec.name, () => createGenericAdapter(spec));
  }
}

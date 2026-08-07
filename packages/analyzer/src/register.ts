/** Register every built-in language adapter. Call once at startup. */
import { registerAdapter } from './adapter.js';
import { PythonAdapter } from './adapters/python.js';
import { TypeScriptAdapter } from './adapters/typescript.js';
import { GoAdapter } from './adapters/go.js';
import { RustAdapter } from './adapters/rust.js';
import { ShellAdapter } from './adapters/shell.js';
import { CppAdapter } from './adapters/cpp.js';
import { CSharpAdapter } from './adapters/csharp.js';
import { JavaAdapter } from './adapters/java.js';
import { RubyAdapter } from './adapters/ruby.js';
import { PhpAdapter } from './adapters/php.js';
import { SwiftAdapter } from './adapters/swift.js';
import { DartAdapter } from './adapters/dart.js';
import { SolidityAdapter } from './adapters/solidity.js';
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
  registerAdapter('java', () => new JavaAdapter());
  registerAdapter('csharp', () => new CSharpAdapter());
  // One C-family adapter: the `cpp` grammar handles C too, the `c` one does not
  // handle C++ at all.
  registerAdapter('cpp', () => new CppAdapter());
  registerAdapter('ruby', () => new RubyAdapter());
  registerAdapter('php', () => new PhpAdapter());
  registerAdapter('dart', () => new DartAdapter());
  registerAdapter('solidity', () => new SolidityAdapter());
  // Swift's grammar aborts the process on V8 >= 13; the adapter refuses at
  // discovery there rather than taking the whole run down (see swift.ts).
  registerAdapter('swift', () => new SwiftAdapter());
  // The long tail: one config-driven engine, one declarative spec per language.
  for (const spec of GENERIC_LANGUAGES) {
    registerAdapter(spec.name, () => createGenericAdapter(spec));
  }
}

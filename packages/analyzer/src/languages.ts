/**
 * tree-sitter (WASM) runtime loading.
 *
 * Grammars come from the `tree-sitter-wasms` package, so no native compilation
 * is ever required. Languages and the runtime are loaded lazily and cached.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let initialized: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

async function ensureInit(): Promise<void> {
  initialized ??= Parser.init();
  await initialized;
}

/**
 * Load (and cache) a grammar by its `tree-sitter-wasms` name, e.g. `python`,
 * `typescript`, `tsx`, `go`, `rust`, `bash`.
 */
export async function loadLanguage(grammar: string): Promise<Language> {
  await ensureInit();
  let cached = languageCache.get(grammar);
  if (!cached) {
    cached = (async () => {
      const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
      return Language.load(readFileSync(wasmPath));
    })();
    languageCache.set(grammar, cached);
  }
  return cached;
}

/**
 * Create a parser bound to a grammar.
 *
 * **The caller owns it and must free it** — see {@link freeParsers}. Grammars are
 * cached and shared; parsers are not, because a `Parser` carries per-parse state
 * and reusing one across concurrent parses would interleave two files' results.
 */
export async function createParser(grammar: string): Promise<Parser> {
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * Free parsers back to the shared WASM runtime.
 *
 * Every `Parser` owns memory inside ONE WASM instance shared by every grammar,
 * and the JavaScript garbage collector cannot reclaim it — `delete()` is the
 * only way back.
 *
 * Parsers are not the expensive leak; **trees are** (see `SpineAdapter.analyze`,
 * where the measurement lives). Freeing them is simply owning what we allocate,
 * which matters most for `statementSpans`: resync calls it once per changed
 * function, so a parser per call adds up in a way one per language does not.
 *
 * Failures are swallowed deliberately: a double-free, or an already-torn-down
 * runtime, must not turn cleanup into the error a caller sees — and there is
 * nothing useful to do about it either way.
 */
export function freeParsers(parsers: Iterable<Parser>): void {
  for (const parser of parsers) {
    try {
      parser.delete();
    } catch {
      // already freed, or the runtime is past saving
    }
  }
}

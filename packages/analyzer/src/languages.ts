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

/** Create a parser bound to a grammar. */
export async function createParser(grammar: string): Promise<Parser> {
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

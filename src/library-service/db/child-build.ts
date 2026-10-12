/**
 * Test support: turns the TypeScript sources of the database layer into plain ES modules a separate Node process can run, so that the
 * crash tests can stop a real process in the middle of a batch. Types are stripped with Node's own `stripTypeScriptTypes`; nothing is
 * bundled or downloaded. The output goes under `node_modules/.cache`, next to the packages the modules import.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, '../../..');

const RELATIVE_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;

export interface BuiltChild { directory: string; entry: string; dispose(): void }

/** Compiles `entrySource` (a path relative to the repository root) and everything it imports through relative paths. */
export function buildChild(entrySource: string): BuiltChild {
  const cache = join(repositoryRoot, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, 'trace-library-child-'));
  const done = new Set<string>();
  const compile = (sourcePath: string): void => {
    if (done.has(sourcePath)) return;
    done.add(sourcePath);
    const stripped = stripTypeScriptTypes(readFileSync(sourcePath, 'utf8'), { mode: 'strip' });
    const imports: string[] = [];
    const rewritten = stripped.replace(RELATIVE_IMPORT, (_all, lead: string, quote: string, specifier: string) => {
      const target = resolve(dirname(sourcePath), specifier);
      imports.push(`${target}.ts`);
      return `${lead}${quote}${specifier}.mjs${quote}`;
    });
    const out = join(directory, relative(repositoryRoot, sourcePath).replace(/\.ts$/, '.mjs'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, rewritten);
    for (const next of imports) compile(next);
  };
  const entryPath = resolve(repositoryRoot, entrySource);
  compile(entryPath);
  return { directory, entry: join(directory, relative(repositoryRoot, entryPath).replace(/\.ts$/, '.mjs')), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

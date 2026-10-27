import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { analyzeRepo, listSourceFiles, parseTsFile, type AnalyzeResult, type TsFileFacts } from "@tracer/core/analyzer";
import { Engine, type FileFacts, type IndexedFile, type WasmLoader } from "@tracer/core/engine";
import { FileCache } from "./cache";
import { nodeFileSystem, prefetch, withCache } from "./nodeFileSystem";

/** WASM from a folder (the extension ships them in dist/grammars), or straight from node_modules. */
export function wasmLoader(dir?: string): WasmLoader {
  if (dir) return (file) => readFileSync(`${dir}/${file}`);
  const require = createRequire(require_resolve_base());
  const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
  const grammars = require.resolve("tree-sitter-wasms/package.json").replace(/package\.json$/, "out/");
  // packages/core/grammars overrides tree-sitter-wasms (see its README).
  const vendored = (file: string): string => fileURLToPath(new URL(`../../core/grammars/${file}`, import.meta.url));
  return (file) => readFileSync(file === "tree-sitter.wasm" ? runtime : existsSync(vendored(file)) ? vendored(file) : grammars + file);
}
// Resolve from @tracer/core, which owns the tree-sitter dependencies.
const require_resolve_base = (): string => createRequire(import.meta.url).resolve("@tracer/core/engine");

export type Progress = { phase: "listing" | "reading" | "parsing" | "linking"; done: number; total: number };

/**
 * The whole workspace graph: TypeScript/JavaScript through the TypeScript resolver, every other supported
 * language through tree-sitter. `root` is absolute with forward slashes.
 *
 * A file cache on disk (`~/.tracer/cache`, see `FileCache`) is checked first: a file whose size and mtime
 * match what was cached last time skips the read and the parse entirely, so a repeat analysis of an
 * unchanged (or mostly unchanged) workspace only redoes the files that actually changed.
 */
export async function analyzeWorkspace(
  root: string,
  opts: { wasmDir?: string; onProgress?: (p: Progress) => void; cacheDir?: string } = {},
): Promise<AnalyzeResult & { parseMs: number }> {
  const progress = opts.onProgress ?? (() => undefined);
  progress({ phase: "listing", done: 0, total: 0 });
  const { files, others } = listSourceFiles(nodeFileSystem, root);
  const fileCache = new FileCache(root, opts.cacheDir);
  const facts = new Map<string, FileFacts>();
  const tsFacts = new Map<string, TsFileFacts>();
  const started = performance.now();

  const missingTs = files.filter((abs) => {
    const cached = fileCache.get(abs, "ts");
    if (cached) tsFacts.set(abs, cached);
    return !cached;
  });
  const missingOthers = others.filter((abs) => {
    const cached = fileCache.get(abs, "facts");
    if (cached) facts.set(abs, cached);
    return !cached;
  });

  progress({ phase: "reading", done: 0, total: missingTs.length + missingOthers.length });
  const cache = await prefetch([...missingTs, ...missingOthers]);
  const fs = withCache(cache);

  for (const abs of missingTs) {
    const r = parseTsFile(fs, abs);
    if (r) {
      tsFacts.set(abs, r);
      fileCache.set(abs, { kind: "ts", data: r });
    }
  }
  if (missingOthers.length) {
    const engine = await Engine.create(wasmLoader(opts.wasmDir));
    for (let i = 0; i < missingOthers.length; i++) {
      const abs = missingOthers[i] as string;
      const text = cache.get(abs);
      if (text !== undefined) {
        const f = await engine.facts(abs, text);
        if (f) {
          facts.set(abs, f);
          fileCache.set(abs, { kind: "facts", data: f });
        }
      }
      if (i % 50 === 0) progress({ phase: "parsing", done: i, total: missingOthers.length });
    }
  }
  fileCache.save();
  const parseMs = Math.round(performance.now() - started);
  progress({ phase: "linking", done: others.length, total: others.length });
  return { ...analyzeRepo(fs, root, { facts, tsFacts }), parseMs };
}

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|\.git|coverage|target|vendor|__pycache__|\.venv|venv|site-packages|\.tox|\.next|\.nuxt|\.gradle)(\/|$)/;

/**
 * tree-sitter facts for every supported file under `root` (TypeScript and JavaScript included), keyed by
 * path relative to the root, with the service (manifest folder) each file belongs to. Feeds the call
 * resolver behind Show Flow and Trace Calls.
 *
 * Shares its on-disk cache with `analyzeWorkspace` (same `FileCache`, same "facts" entries for non-TypeScript
 * files): opening Map/Graph once speeds up the first Show Flow/Trace Calls index too, and vice versa.
 */
export async function indexWorkspace(
  root: string,
  opts: { wasmDir?: string; onProgress?: (p: Progress) => void; cacheDir?: string } = {},
): Promise<IndexedFile[]> {
  const progress = opts.onProgress ?? (() => undefined);
  const { files, others, services } = listSourceFiles(nodeFileSystem, root);
  const all = [...files, ...others].filter((abs) => !SKIP_DIRS.test(abs.slice(root.length + 1)));
  const serviceOf = (rel: string): string =>
    services.reduce((best, s) => (s.path.length > best.length && (rel === s.path || rel.startsWith(`${s.path}/`)) ? s.path : best), "");
  const fileCache = new FileCache(root, opts.cacheDir);
  const result = new Map<string, IndexedFile>(); // by absolute path, filled in `all`'s order below

  const missing = all.filter((abs) => {
    const cached = fileCache.get(abs, "facts");
    if (cached) {
      const rel = abs.slice(root.length + 1);
      result.set(abs, { path: rel, facts: cached, service: serviceOf(rel) });
    }
    return !cached;
  });

  progress({ phase: "reading", done: 0, total: missing.length });
  if (missing.length) {
    const engine = await Engine.create(wasmLoader(opts.wasmDir));
    const cache = await prefetch(missing);
    for (let i = 0; i < missing.length; i++) {
      const abs = missing[i] as string;
      const text = cache.get(abs) ?? nodeFileSystem.readFile(abs);
      if (text !== undefined && text.length < 1_500_000) {
        const rel = abs.slice(root.length + 1);
        const facts = await engine.facts(abs, text);
        if (facts) {
          result.set(abs, { path: rel, facts, service: serviceOf(rel) });
          fileCache.set(abs, { kind: "facts", data: facts });
        }
      }
      if (i % 100 === 0) progress({ phase: "parsing", done: i, total: missing.length });
    }
  }
  fileCache.save();
  return all.flatMap((abs) => result.get(abs) ?? []); // preserves `all`'s order, same as before caching
}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { analyzeRepo, listSourceFiles, type AnalyzeResult } from "@tracer/core/analyzer";
import { Engine, type FileFacts, type IndexedFile, type WasmLoader } from "@tracer/core/engine";
import { nodeFileSystem, prefetch, withCache } from "./nodeFileSystem";

/** WASM from a folder (the extension ships them in dist/grammars), or straight from node_modules. */
export function wasmLoader(dir?: string): WasmLoader {
  if (dir) return (file) => readFileSync(`${dir}/${file}`);
  const require = createRequire(require_resolve_base());
  const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
  const grammars = require.resolve("tree-sitter-wasms/package.json").replace(/package\.json$/, "out/");
  return (file) => readFileSync(file === "tree-sitter.wasm" ? runtime : grammars + file);
}
// Resolve from @tracer/core, which owns the tree-sitter dependencies.
const require_resolve_base = (): string => createRequire(import.meta.url).resolve("@tracer/core/engine");

export type Progress = { phase: "listing" | "reading" | "parsing" | "linking"; done: number; total: number };

/**
 * The whole workspace graph: TypeScript/JavaScript through the TypeScript resolver, every other supported
 * language through tree-sitter. `root` is absolute with forward slashes.
 */
export async function analyzeWorkspace(
  root: string,
  opts: { wasmDir?: string; onProgress?: (p: Progress) => void } = {},
): Promise<AnalyzeResult & { parseMs: number }> {
  const progress = opts.onProgress ?? (() => undefined);
  progress({ phase: "listing", done: 0, total: 0 });
  const { files, others } = listSourceFiles(nodeFileSystem, root);
  const facts = new Map<string, FileFacts>();
  const started = performance.now();
  progress({ phase: "reading", done: 0, total: files.length + others.length });
  const cache = await prefetch([...files, ...others]);
  const fs = withCache(cache);
  if (others.length) {
    const engine = await Engine.create(wasmLoader(opts.wasmDir));
    for (let i = 0; i < others.length; i++) {
      const abs = others[i] as string;
      const text = cache.get(abs);
      if (text !== undefined) {
        const f = await engine.facts(abs, text);
        if (f) facts.set(abs, f);
      }
      if (i % 50 === 0) progress({ phase: "parsing", done: i, total: others.length });
    }
  }
  const parseMs = Math.round(performance.now() - started);
  progress({ phase: "linking", done: others.length, total: others.length });
  return { ...analyzeRepo(fs, root, { facts }), parseMs };
}

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|\.git|coverage|target|vendor|__pycache__)(\/|$)/;

/**
 * tree-sitter facts for every supported file under `root` (TypeScript and JavaScript included), keyed by
 * path relative to the root, with the service (manifest folder) each file belongs to. Feeds the call
 * resolver behind Show Flow and Trace Calls.
 */
export async function indexWorkspace(
  root: string,
  opts: { wasmDir?: string; onProgress?: (p: Progress) => void } = {},
): Promise<IndexedFile[]> {
  const progress = opts.onProgress ?? (() => undefined);
  const { files, others, services } = listSourceFiles(nodeFileSystem, root);
  const all = [...files, ...others].filter((abs) => !SKIP_DIRS.test(abs.slice(root.length + 1)));
  const serviceOf = (rel: string): string =>
    services.reduce((best, s) => (s.path.length > best.length && (rel === s.path || rel.startsWith(`${s.path}/`)) ? s.path : best), "");
  const engine = await Engine.create(wasmLoader(opts.wasmDir));
  const out: IndexedFile[] = [];
  progress({ phase: "reading", done: 0, total: all.length });
  const cache = await prefetch(all);
  for (let i = 0; i < all.length; i++) {
    const abs = all[i] as string;
    const text = cache.get(abs) ?? nodeFileSystem.readFile(abs);
    if (text !== undefined && text.length < 1_500_000) {
      const rel = abs.slice(root.length + 1);
      const facts = await engine.facts(abs, text);
      if (facts) out.push({ path: rel, facts, service: serviceOf(rel) });
    }
    if (i % 100 === 0) progress({ phase: "parsing", done: i, total: all.length });
  }
  return out;
}

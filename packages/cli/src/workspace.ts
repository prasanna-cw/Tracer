import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { analyzeRepo, listSourceFiles, type AnalyzeResult } from "@tracer/core/analyzer";
import { Engine, type FileFacts, type WasmLoader } from "@tracer/core/engine";
import { nodeFileSystem } from "./nodeFileSystem";

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

export type Progress = { phase: "listing" | "parsing" | "linking"; done: number; total: number };

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
  const { others } = listSourceFiles(nodeFileSystem, root);
  const facts = new Map<string, FileFacts>();
  const started = performance.now();
  if (others.length) {
    const engine = await Engine.create(wasmLoader(opts.wasmDir));
    for (let i = 0; i < others.length; i++) {
      const abs = others[i] as string;
      const text = nodeFileSystem.readFile(abs);
      if (text !== undefined) {
        const f = await engine.facts(abs, text);
        if (f) facts.set(abs, f);
      }
      if (i % 50 === 0) progress({ phase: "parsing", done: i, total: others.length });
    }
  }
  const parseMs = Math.round(performance.now() - started);
  progress({ phase: "linking", done: others.length, total: others.length });
  return { ...analyzeRepo(nodeFileSystem, root, { facts }), parseMs };
}

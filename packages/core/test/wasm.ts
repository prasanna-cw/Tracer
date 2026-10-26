import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { WasmLoader } from "../src/engine";

const require = createRequire(import.meta.url);
const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
const grammars = require.resolve("tree-sitter-wasms/package.json").replace(/package\.json$/, "out/");
// packages/core/grammars overrides tree-sitter-wasms (see its README).
const vendored = (file: string): string => fileURLToPath(new URL(`../grammars/${file}`, import.meta.url));

/** Test/CLI loader: WASM files straight from node_modules. */
export const nodeWasm: WasmLoader = (file) => readFileSync(file === "tree-sitter.wasm" ? runtime : existsSync(vendored(file)) ? vendored(file) : grammars + file);

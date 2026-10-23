import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { WasmLoader } from "../src/engine";

const require = createRequire(import.meta.url);
const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
const grammars = require.resolve("tree-sitter-wasms/package.json").replace(/package\.json$/, "out/");

/** Test/CLI loader: WASM files straight from node_modules. */
export const nodeWasm: WasmLoader = (file) => readFileSync(file === "tree-sitter.wasm" ? runtime : grammars + file);

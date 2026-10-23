// Builds the extension: two Node bundles (extension host + analyzer worker), the integration test suite,
// the WASM parsers, and the web app as the webview bundle. Rebuild with `npm run build`.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
rmSync(resolve(here, "dist"), { recursive: true, force: true });

const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  logLevel: "warning",
  absWorkingDir: here,
  // ESM dependencies (web-tree-sitter picks its ESM build for 'import') read import.meta.url, which a CommonJS
  // bundle does not have: give them this file's real URL.
  define: { "import.meta.url": "__tracerImportMetaUrl" },
  banner: { js: "var __tracerImportMetaUrl = require('url').pathToFileURL(__filename).href;" },
};
await Promise.all([
  build({ ...node, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", minify: true, sourcemap: "linked" }),
  // The TypeScript compiler and tree-sitter live in this bundle only, loaded when the graph command runs.
  build({ ...node, entryPoints: ["src/analyzerWorker.ts"], outfile: "dist/analyzerWorker.js", minify: true }),
  build({ ...node, entryPoints: ["test/e2e/suite.ts"], outfile: "dist/test/suite.js" }),
]);

// WASM: the tree-sitter runtime and exactly the grammars languages.ts declares (single source of truth).
const require = createRequire(resolve(repo, "packages/core/src/engine/index.ts"));
const grammarsDir = resolve(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const declared = [...readFileSync(resolve(repo, "packages/core/src/engine/languages.ts"), "utf8").matchAll(/grammar: "([a-z_]+)"/g)].map((m) => m[1]);
const out = resolve(here, "dist/grammars");
mkdirSync(out, { recursive: true });
copyFileSync(require.resolve("web-tree-sitter/tree-sitter.wasm"), resolve(out, "tree-sitter.wasm"));
for (const g of new Set(declared)) copyFileSync(resolve(grammarsDir, `tree-sitter-${g}.wasm`), resolve(out, `tree-sitter-${g}.wasm`));
console.log(`grammars: ${new Set(declared).size} + runtime -> dist/grammars`);

execSync("npm run build:webview -w @tracer/app", { cwd: repo, stdio: "inherit" });

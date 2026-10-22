// Builds the extension: two Node bundles (extension host + analyzer worker), the integration test suite,
// and the web app as the webview bundle. `--watch` is not supported; rebuild with `npm run build`.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
rmSync(resolve(here, "dist"), { recursive: true, force: true });

const node = { bundle: true, platform: "node", format: "cjs", target: "node18", external: ["vscode"], logLevel: "warning", absWorkingDir: here };
await Promise.all([
  build({ ...node, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", minify: true, sourcemap: "linked" }),
  // The TypeScript compiler lives in this bundle only (it is several MB), loaded when the graph command runs.
  build({ ...node, entryPoints: ["src/analyzerWorker.ts"], outfile: "dist/analyzerWorker.js", minify: true }),
  build({ ...node, entryPoints: ["test/e2e/suite.ts"], outfile: "dist/test/suite.js" }),
]);

execSync("npm run build:webview -w @codemap/app", { cwd: repo, stdio: "inherit" });

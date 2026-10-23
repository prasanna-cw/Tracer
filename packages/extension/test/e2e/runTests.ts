// Downloads a VS Code build (cached in the OS temp folder), opens samples/demo-repo with only this
// extension enabled, and runs dist/test/suite.js inside it. Run with: npm run test:vscode
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = fileURLToPath(new URL(".", import.meta.url));
const realRepo = resolve(here, "../../../..");
const scratch = join(tmpdir(), "tracer-vscode-test");

/**
 * test-electron launches VS Code on Windows in a way that splits arguments at spaces, so a checkout in
 * e.g. "C:\Users\me\rust learning\" fails. Point VS Code at the repo through a space-free junction
 * (no admin rights needed) in the temp folder instead.
 */
function spaceFreeRepo(): string {
  if (!realRepo.includes(" ")) return realRepo;
  if (scratch.includes(" ")) throw new Error(`the temp folder has a space too: ${scratch}`);
  mkdirSync(scratch, { recursive: true });
  const link = join(scratch, "repo");
  if (existsSync(link) && realpathSync(link) !== realpathSync(realRepo)) rmSync(link, { recursive: false, force: true });
  if (!existsSync(link)) symlinkSync(realRepo, link, "junction");
  return link;
}

// Set when this runs from a terminal inside VS Code (or an extension): the test VS Code would then start as
// plain Node and try to "run" its first argument as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

const repo = spaceFreeRepo();
const extensionDevelopmentPath = join(repo, "packages", "extension");

runTests({
  extensionDevelopmentPath,
  extensionTestsPath: join(extensionDevelopmentPath, "dist", "test", "suite.js"),
  cachePath: scratch,
  launchArgs: [
    join(repo, "samples", "demo-repo"),
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    `--user-data-dir=${join(scratch, "user-data")}`,
  ],
}).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

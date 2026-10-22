import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { analyzeRepo, toPosix, type AnalyzeResult } from "@codemap/core/analyzer";
import { nodeFileSystem } from "./nodeFileSystem";

const USAGE = "Usage: npm run analyze -- --root <path-to-repo> --out <graph.json>";
const fromUserCwd = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);

export function analyzePath(root: string): AnalyzeResult {
  const abs = toPosix(fromUserCwd(root));
  if (!nodeFileSystem.directoryExists(abs)) throw new Error(`--root is not a directory: ${abs}`);
  return analyzeRepo(nodeFileSystem, abs);
}

export const serializeGraph = (r: AnalyzeResult): string => JSON.stringify(r.graph, null, 2) + "\n";

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { root: { type: "string" }, out: { type: "string" } } });
  if (!values.root || !values.out) throw new Error(USAGE);

  const started = performance.now();
  const result = analyzePath(values.root);
  const ms = Math.round(performance.now() - started);

  const out = fromUserCwd(values.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, serializeGraph(result), "utf8");

  const s = result.graph.summary;
  console.log(
    [
      `files       ${s.fileCount}${s.skippedCount ? ` (+${s.skippedCount} skipped)` : ""}`,
      `edges       ${s.edgeCount}`,
      `unresolved  ${s.unresolvedCount}`,
      `external    ${s.externalCount}`,
      `assets      ${s.assetCount}`,
      `cycles      ${s.cycleCount} (${result.cycleEdges} edges)`,
      `time        ${ms} ms`,
      `wrote       ${values.out}`,
    ].join("\n"),
  );
  for (const w of s.warnings.slice(0, 20)) console.warn(`warning: ${w}`);
  if (s.warnings.length > 20) console.warn(`warning: ...and ${s.warnings.length - 20} more (see summary.warnings in the output)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fromJsonCanvas, parseDiagram, toJsonCanvas } from "@tracer/core";

// npm runs scripts from the package root; INIT_CWD is where the user actually typed the command.
const fromUserCwd = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`, { cause: e });
  }
  try {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown; // tolerate BOMs from Windows editors
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${(e as Error).message}`, { cause: e });
  }
}

const writeJson = (path: string, data: unknown, indent: string | number): Promise<void> =>
  writeFile(path, JSON.stringify(data, null, indent) + "\n", "utf8");

/** Both commands resolve to the warnings worth showing the user (none for export). */
export async function exportCanvasFile(inPath: string, outPath: string): Promise<string[]> {
  const r = parseDiagram(await readJson(inPath));
  if (!r.ok) throw new Error(`${inPath} is not a valid diagram:\n  ${r.errors.join("\n  ")}`);
  await writeJson(outPath, toJsonCanvas(r.value), "\t"); // Obsidian writes tabs
  return r.warnings;
}

export async function importCanvasFile(inPath: string, outPath: string): Promise<string[]> {
  const r = fromJsonCanvas(await readJson(inPath), { title: basename(inPath).replace(/\.canvas$/i, "") });
  if (!r.ok) throw new Error(`${inPath} is not a valid JSON Canvas:\n  ${r.errors.join("\n  ")}`);
  await writeJson(outPath, r.value, 2);
  return r.warnings;
}

const COMMANDS = { export: exportCanvasFile, import: importCanvasFile } as const;

async function main(argv: string[]): Promise<void> {
  const [cmd, input, output] = argv;
  if (!(cmd === "export" || cmd === "import") || !input || !output) {
    throw new Error(
      "Usage:\n  npm run export:canvas -- <in.diagram.json> <out.canvas>\n  npm run import:canvas -- <in.canvas> <out.diagram.json>",
    );
  }
  const [inPath, outPath] = [fromUserCwd(input), fromUserCwd(output)];
  const warnings = await COMMANDS[cmd](inPath, outPath);
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(`${cmd}: ${input} -> ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { diagramToText, type Diagram } from "@tracer/core";
import { toPosix } from "@tracer/core/analyzer";
import { buildFunctionIndex, callTrace, Engine, fileOverview } from "@tracer/core/engine";
import { indexWorkspace, wasmLoader } from "./workspace";

const USAGE = `Usage: npm run flow -- --root <repo> --file <path inside repo> [--line N [--end M] | --trace] --out <flow.diagram.json>
  (no --line)       overview of the file
  --line N          control flow of the function containing line N
  --line N --end M  flow of the statements on lines N..M
  --trace           with --line: the call tree from that function, across files (--depth 1-8, default 4)`;
const fromUserCwd = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);

export async function generateFlow(a: { root: string; file: string; line?: number; end?: number; trace?: boolean; depth?: number }): Promise<Diagram> {
  const root = toPosix(fromUserCwd(a.root));
  const rel = toPosix(relative(root, fromUserCwd(a.file)));
  if (rel.startsWith("..")) throw new Error(`--file must be inside --root (${rel})`);
  const text = await readFile(fromUserCwd(a.file), "utf8");
  const files = new Map((await indexWorkspace(root)).map((f) => [f.path, f]));
  const engine = await Engine.create(wasmLoader());
  const fresh = await engine.facts(rel, text);
  if (!fresh) throw new Error(`Tracer does not read ${rel}`);
  files.set(rel, { path: rel, facts: fresh, service: files.get(rel)?.service ?? "" });
  const index = buildFunctionIndex(files.values());
  if (a.trace) {
    if (!a.line) throw new Error("--trace needs --line");
    const t = callTrace(index, { path: rel, line: a.line }, a.depth ?? 4);
    if (!t.ok) throw new Error(t.reason);
    return t.diagram;
  }
  if (!a.line) {
    const o = fileOverview(files.get(rel) as NonNullable<ReturnType<typeof files.get>>, index);
    if (!o.ok) throw new Error(o.reason);
    return o.diagram;
  }
  const r = await engine.flow(rel, text, a.end ? { kind: "selection", startLine: a.line, endLine: a.end } : { kind: "function", line: a.line }, index.resolve);
  if (!r.ok) throw new Error(r.reason);
  return r.diagram;
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: "string" }, file: { type: "string" }, line: { type: "string" }, end: { type: "string" }, out: { type: "string" }, trace: { type: "boolean" }, depth: { type: "string" } },
  });
  if (!values.root || !values.file || !values.out) throw new Error(USAGE);
  const started = performance.now();
  const diagram = await generateFlow({
    root: values.root,
    file: values.file,
    line: values.line ? Number(values.line) : undefined,
    end: values.end ? Number(values.end) : undefined,
    trace: values.trace,
    depth: values.depth ? Number(values.depth) : undefined,
  });
  const out = fromUserCwd(values.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, diagramToText(out, diagram), "utf8");
  console.log(`${diagram.title}: ${diagram.nodes.length} nodes, ${diagram.edges.length} edges in ${Math.round(performance.now() - started)} ms -> ${values.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

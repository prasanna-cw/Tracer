import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { buildMap, initialMapState, activateMapItem } from "@tracer/core";
import { toPosix } from "@tracer/core/analyzer";
import { buildFunctionIndex, callTrace, Engine } from "@tracer/core/engine";
import { analyzeWorkspace, indexWorkspace, wasmLoader } from "./workspace";

/**
 * `npm run bench -- --files 6000`: builds a throwaway workspace of 10 services in 8 languages (every file
 * imports a few earlier files of its own service), then times each stage Tracer runs on a real repo.
 */

type Gen = { name: string; manifest: [string, string]; ext: string; file: (i: number, deps: number[], dir: number) => string; path: (i: number, dir: number) => string };
const DIRS = 24;

const GENERATORS: Gen[] = [
  {
    name: "orders-java", manifest: ["pom.xml", "<project/>"], ext: "java",
    path: (i, d) => `src/main/java/com/acme/p${d}/C${i}.java`,
    file: (i, deps, d) => `package com.acme.p${d};\n${deps.map((j) => `import com.acme.p${j % DIRS}.C${j};`).join("\n")}\npublic class C${i} {\n  ${deps.map((j) => `C${j} f${j};`).join(" ")}\n  public int run(int n) {\n    for (int k = 0; k < n; k++) { if (k % 2 == 0) { n += k; } else { n -= 1; } }\n    return n;\n  }\n}\n`,
  },
  {
    name: "billing-kotlin", manifest: ["build.gradle.kts", "plugins {}"], ext: "kt",
    path: (i, d) => `src/main/kotlin/com/acme/b${d}/K${i}.kt`,
    file: (i, deps, d) => `package com.acme.b${d}\n${deps.map((j) => `import com.acme.b${j % DIRS}.K${j}`).join("\n")}\nclass K${i} {\n  fun run(n: Int): Int {\n    ${deps.map((j) => `val a${j}: K${j}? = null`).join("\n    ")}\n    return n\n  }\n}\n`,
  },
  {
    name: "users-python", manifest: ["pyproject.toml", "[project]\nname='u'"], ext: "py",
    path: (i, d) => `app/d${d}/m${i}.py`,
    file: (i, deps) => `${deps.map((j) => `from app.d${j % DIRS}.m${j} import f${j}`).join("\n")}\n\ndef f${i}(x):\n    for k in range(x):\n        if k % 2:\n            x += k\n    return x\n`,
  },
  {
    name: "inventory-go", manifest: ["go.mod", "module acme.com/inv\n\ngo 1.22\n"], ext: "go",
    path: (i, d) => `internal/d${d}/g${i}.go`,
    file: (i, deps, d) => `package d${d}\n\nimport (\n${deps.map((j) => `\t_ "acme.com/inv/internal/d${j % DIRS}"`).join("\n")}\n)\n\nfunc G${i}(n int) int {\n\tfor k := 0; k < n; k++ {\n\t\tif k%2 == 0 {\n\t\t\tn += k\n\t\t}\n\t}\n\treturn n\n}\n`,
  },
  {
    name: "payments-csharp", manifest: ["Payments.csproj", "<Project/>"], ext: "cs",
    path: (i, d) => `Services/D${d}/S${i}.cs`,
    file: (i, deps, d) => `${deps.map((j) => `using Acme.D${j % DIRS};`).join("\n")}\nnamespace Acme.D${d} {\n  public class S${i} {\n    ${deps.map((j) => `S${j} f${j};`).join(" ")}\n    public int Run(int n) { try { return n; } catch (System.Exception) { throw; } }\n  }\n}\n`,
  },
  {
    name: "legacy-php", manifest: ["composer.json", "{}"], ext: "php",
    path: (i, d) => `src/D${d}/P${i}.php`,
    file: (i, deps, d) => `<?php\nnamespace App\\D${d};\n${deps.map((j) => `use App\\D${j % DIRS}\\P${j};`).join("\n")}\nclass P${i} {\n  public function run($n) {\n    foreach ([1,2] as $k) { if ($k) { $n += $k; } }\n    return $n;\n  }\n}\n`,
  },
  {
    name: "notify-ruby", manifest: ["Gemfile", "source 'x'"], ext: "rb",
    path: (i, d) => `lib/d${d}/r${i}.rb`,
    file: (i, deps) => `${deps.map((j) => `require_relative "../d${j % DIRS}/r${j}"`).join("\n")}\nclass R${i}\n  def run(n)\n    if n > 1\n      n += 1\n    end\n    n\n  end\nend\n`,
  },
  {
    name: "web-ts", manifest: ["package.json", '{"name":"web"}'], ext: "ts",
    path: (i, d) => `src/d${d}/m${i}.ts`,
    file: (i, deps) => `${deps.map((j) => `import { f${j} } from "../d${j % DIRS}/m${j}";`).join("\n")}\nexport function f${i}(n: number): number {\n  for (let k = 0; k < n; k++) { if (k % 2) { n += k; } }\n  return n${deps.map((j) => ` + f${j}(1)`).join("")};\n}\n`,
  },
  {
    name: "admin-ts", manifest: ["package.json", '{"name":"admin"}'], ext: "ts",
    path: (i, d) => `src/d${d}/m${i}.ts`,
    file: (i, deps) => `${deps.map((j) => `import { f${j} } from "../d${j % DIRS}/m${j}";`).join("\n")}\nexport const f${i} = (n: number): number => n${deps.map((j) => ` + f${j}(1)`).join("")};\n`,
  },
  {
    name: "api-ts", manifest: ["package.json", '{"name":"api"}'], ext: "ts",
    path: (i, d) => `src/d${d}/m${i}.ts`,
    file: (i, deps) => `${deps.map((j) => `import { f${j} } from "../d${j % DIRS}/m${j}";`).join("\n")}\nexport async function f${i}(n: number) {\n  try { return n${deps.map((j) => ` + f${j}(1)`).join("")}; } catch (e) { throw e; }\n}\n`,
  },
];

export function generate(root: string, total: number): { files: number; services: number } {
  const per = Math.max(1, Math.floor(total / GENERATORS.length));
  let files = 0;
  for (const g of GENERATORS) {
    const dir = join(root, g.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, g.manifest[0]), g.manifest[1]);
    // Same-service imports of earlier files, the way most real code reaches "downward".
    for (let i = 0; i < per; i++) {
      const d = i % DIRS;
      const deps = [1, 3, 7].map((k) => i - k).filter((j) => j >= 0);
      const abs = join(dir, g.path(i, d));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, g.file(i, deps, d));
      if (g.ext === "py" && i < DIRS) writeFileSync(join(dirname(abs), "__init__.py"), "");
      files++;
    }
  }
  return { files, services: GENERATORS.length };
}

const ms = (since: number): string => `${Math.round(performance.now() - since)} ms`.padStart(9);

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { files: { type: "string" }, keep: { type: "boolean" } } });
  const total = Number(values.files ?? 3000);
  const root = toPosix(mkdtempSync(join(tmpdir(), "tracer-bench-")));
  try {
    let t = performance.now();
    const made = generate(root, total);
    console.log(`generated   ${made.files} files, ${made.services} services in 8 languages        ${ms(t)}`);

    t = performance.now();
    const { graph } = await analyzeWorkspace(root);
    const s = graph.summary;
    console.log(`analyze     ${s.fileCount} files, ${s.edgeCount} edges, ${s.unresolvedCount} unresolved, ${s.cycleCount} cycles  ${ms(t)}`);
    console.log(`            ${JSON.stringify(s.languages)}`);

    t = performance.now();
    const m0 = initialMapState(graph);
    const first = buildMap(graph, m0);
    console.log(`map (open)  ${first.diagram.nodes.length} cards, ${first.diagram.edges.length} edges                            ${ms(t)}`);

    const biggest = [...first.items].filter(([, it]) => it.kind === "dir").map(([id]) => id).find((id) => id !== "d:") ?? "d:";
    t = performance.now();
    const second = buildMap(graph, activateMapItem(m0, biggest, { kind: "dir", path: biggest.slice(2) }));
    console.log(`map (click) ${second.diagram.nodes.length} cards after opening ${biggest}                  ${ms(t)}`);

    t = performance.now();
    const files = new Map((await indexWorkspace(root)).map((f) => [f.path, f]));
    console.log(`index       ${files.size} files (functions + types for Show Flow)                ${ms(t)}`);

    t = performance.now();
    const index = buildFunctionIndex(files.values());
    const start = [...files.values()].find((f) => f.path.startsWith("orders-java") && f.facts.functions.length);
    const fn = start?.facts.functions[0];
    const trace = start && fn ? callTrace(index, { path: start.path, line: fn.line }, 4) : undefined;
    console.log(`trace       ${trace?.ok ? `${trace.diagram.nodes.length} functions across files` : "n/a"}                              ${ms(t)}`);

    const engine = await Engine.create(wasmLoader());
    if (start && fn) {
      t = performance.now();
      const text = (await import("node:fs")).readFileSync(join(root, start.path), "utf8");
      const flow = await engine.flow(start.path, text, { kind: "function", line: fn.line }, index.resolve);
      console.log(`flow        ${flow.ok ? `${flow.diagram.nodes.length} nodes` : flow.reason}                                   ${ms(t)}`);
    }
    console.log(`memory      ${Math.round(process.memoryUsage().rss / 1048576)} MB resident`);
  } finally {
    if (!values.keep) rmSync(root, { recursive: true, force: true });
    else console.log(`kept        ${root}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

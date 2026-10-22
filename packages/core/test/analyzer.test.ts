import { describe, expect, it } from "vitest";
import { analyzeRepo, parseGitignore, type FileSystemHost } from "../src/analyzer";

/** In-memory FileSystemHost: proves the analyzer needs nothing but the port. */
function memoryFs(files: Record<string, string>, root = "/repo"): FileSystemHost {
  const abs = new Map(Object.entries(files).map(([p, c]) => [`${root}/${p}`, c]));
  const dirs = new Set<string>([root]);
  for (const p of abs.keys()) for (let d = p.slice(0, p.lastIndexOf("/")); d.length >= root.length; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  return {
    readFile: (p) => abs.get(p),
    fileExists: (p) => abs.has(p),
    directoryExists: (p) => dirs.has(p),
    readDirectory: (p) => {
      const names = new Map<string, boolean>();
      for (const f of [...abs.keys(), ...dirs]) {
        if (f.startsWith(`${p}/`)) {
          const rest = f.slice(p.length + 1);
          const name = rest.split("/")[0]!;
          names.set(name, (names.get(name) ?? false) || rest.includes("/") || dirs.has(`${p}/${name}`));
        }
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
  };
}

const edgesOf = (files: Record<string, string>) =>
  analyzeRepo(memoryFs(files), "/repo").graph.edges.map((e) => `${e.source} -> ${e.target}`);

describe("analyzeRepo (in-memory)", () => {
  it("works without a tsconfig (JS included, extensionless and index resolution)", () => {
    expect(edgesOf({ "a.js": 'import "./b"; import "./lib";', "b.js": "", "lib/index.js": "" })).toEqual([
      "a.js -> b.js",
      "a.js -> lib/index.js",
    ]);
  });

  it("counts require() in .ts, import x = require(), and template-literal dynamic imports", () => {
    expect(
      edgesOf({
        "a.ts": 'const x = require("./b"); import y = require("./c"); const z = import(`./d`);',
        "b.ts": "",
        "c.ts": "",
        "d.ts": "",
      }),
    ).toEqual(["a.ts -> b.ts", "a.ts -> c.ts", "a.ts -> d.ts"]);
  });

  it("ignores node_modules, dist, .d.ts files and .gitignore entries; drops self-imports", () => {
    const files = {
      ".gitignore": "# generated\ngenerated/\n*.gen.ts\n/scratch.ts\n",
      "a.ts": 'import "./a"; import "./generated/x"; import "./y.gen"; import "./types";',
      "generated/x.ts": "",
      "y.gen.ts": "",
      "scratch.ts": "",
      "deep/scratch.ts": "", // /scratch.ts is anchored to the root: this one stays
      "types.d.ts": "",
      "node_modules/pkg/index.js": "",
      "dist/out.js": "",
    };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.nodes.map((n) => n.path)).toEqual(["a.ts", "deep/scratch.ts"]);
    expect(g.edges).toEqual([]);
    expect(g.summary.unresolvedCount).toBe(3); // generated/x, y.gen, types (ignored files are not in the graph)
  });

  it("an empty repo and a repo with zero imports are fine", () => {
    expect(analyzeRepo(memoryFs({}), "/repo").graph.summary).toMatchObject({ fileCount: 0, edgeCount: 0, cycleCount: 0 });
    const g = analyzeRepo(memoryFs({ "a.ts": "export const a = 1;", "b.ts": "" }), "/repo").graph;
    expect([g.summary.fileCount, g.summary.edgeCount]).toEqual([2, 0]);
  });

  it("reports a broken tsconfig and carries on with defaults", () => {
    const g = analyzeRepo(memoryFs({ "tsconfig.json": "{ nope", "a.ts": 'import "./b";', "b.ts": "" }), "/repo").graph;
    expect(g.edges).toHaveLength(1);
    expect(g.summary.warnings[0]).toMatch(/^tsconfig\.json: /);
  });

  it("honors tsconfig extends + paths", () => {
    const files = {
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      "src/a.ts": 'import "~/b"; import "~/missing";',
      "src/b.ts": "",
    };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.edges).toEqual([{ source: "src/a.ts", target: "src/b.ts" }]);
    expect(g.summary.unresolved).toEqual([{ from: "src/a.ts", specifier: "~/missing" }]); // alias miss: unresolved, not external
  });
});

describe("parseGitignore", () => {
  const { matches, unsupported } = parseGitignore("logs/\n*.tmp\n/root-only.ts\nsrc/**/gen\n!keep.tmp\n");
  it.each([
    ["logs", true, true],
    ["a/logs", true, true],
    ["logs", false, false], // dir-only pattern does not match a file
    ["x.tmp", false, true],
    ["deep/x.tmp", false, true],
    ["root-only.ts", false, true],
    ["sub/root-only.ts", false, false],
    ["src/gen", true, true],
    ["src/a/b/gen", true, true],
    ["other/gen", true, false],
  ])("%s (dir=%s) -> %s", (path, isDir, expected) => {
    expect(matches(path, isDir)).toBe(expected);
  });
  it("reports negation as unsupported", () => expect(unsupported).toEqual(["!keep.tmp"]));
});

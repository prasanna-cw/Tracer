import { describe, expect, it } from "vitest";
import { analyzeRepo, parseGitignore, type FileSystemHost } from "../src/analyzer";
import type { FileFacts } from "../src/engine";

/**
 * In-memory FileSystemHost: proves the analyzer needs nothing but the port.
 * `links` maps a symlink directory to its target (both relative to root), like npm workspaces in node_modules.
 */
function memoryFs(files: Record<string, string>, links: Record<string, string> = {}, root = "/repo"): FileSystemHost {
  const abs = new Map(Object.entries(files).map(([p, c]) => [`${root}/${p}`, c]));
  const dirs = new Set<string>([root]);
  const linkDirs = Object.keys(links).map((l) => `${root}/${l}/x`); // the link itself and its parents are directories
  for (const p of [...abs.keys(), ...linkDirs]) for (let d = p.slice(0, p.lastIndexOf("/")); d.length >= root.length; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  const real = (p: string): string => {
    for (const [from, to] of Object.entries(links)) {
      const link = `${root}/${from}`;
      if (p === link || p.startsWith(`${link}/`)) return `${root}/${to}${p.slice(link.length)}`;
    }
    return p;
  };
  return {
    readFile: (p) => abs.get(real(p)),
    fileExists: (p) => abs.has(real(p)),
    directoryExists: (p) => dirs.has(real(p)),
    realpath: real,
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

  it("follows npm workspace symlinks back into the repo (cross-package edges are internal)", () => {
    const files = {
      "packages/lib/package.json": JSON.stringify({ name: "@x/lib", exports: { ".": "./src/index.ts" } }),
      "packages/lib/src/index.ts": "export const x = 1;",
      "packages/app/src/main.ts": 'import { x } from "@x/lib"; import "react";',
    };
    const g = analyzeRepo(memoryFs(files, { "node_modules/@x/lib": "packages/lib" }), "/repo").graph;
    expect(g.edges).toEqual([{ source: "packages/app/src/main.ts", target: "packages/lib/src/index.ts" }]);
    expect([g.summary.externalCount, g.summary.unresolvedCount]).toEqual([1, 0]); // only react
  });

  it("counts existing non-code imports as assets, not unresolved", () => {
    const files = {
      "src/main.ts": 'import "./app.css"; import data from "../data.json"; import "./missing.css";',
      "src/app.css": "body {}",
      "data.json": "{}",
    };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.summary).toMatchObject({ assetCount: 2, unresolvedCount: 1, externalCount: 0 });
    expect(g.summary.unresolved).toEqual([{ from: "src/main.ts", specifier: "./missing.css" }]);
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

describe("docs and docker-compose (cross-links)", () => {
  it("links a markdown doc to a file via a relative link, and adds the doc as its own node", () => {
    const files = { "README.md": "See [the core module](./src/core.ts) for details.", "src/core.ts": "export const x = 1;" };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.nodes.find((n) => n.path === "README.md")).toMatchObject({ lang: "markdown", ext: "md" });
    expect(g.edges).toEqual([{ source: "README.md", target: "src/core.ts" }]);
  });

  it("ignores an external link and a link to a file outside the graph", () => {
    const files = { "README.md": "[docs](https://example.com) and [ghost](./nope.ts)." };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.edges).toEqual([]);
  });

  const factsOf = (abs: string, names: string[]): [string, FileFacts] => [
    abs,
    { lang: "python", loc: 1, imports: [], types: names.map((name) => ({ name, kind: "class" as const, line: 1 })), functions: [], typeRefs: [], syntaxErrors: false },
  ];

  it("links a markdown code span to the one file declaring that symbol (tree-sitter facts)", () => {
    const files = { "README.md": "Call `Widget` to render it.", "lib.py": "class Widget: pass" };
    const facts = new Map([factsOf("/repo/lib.py", ["Widget"])]);
    const g = analyzeRepo(memoryFs(files), "/repo", { facts }).graph;
    expect(g.edges).toEqual([{ source: "README.md", target: "lib.py" }]);
  });

  it("skips an ambiguous code span: a wrong link is worse than no link", () => {
    const files = { "README.md": "See `Widget`.", "a.py": "class Widget: pass", "b.py": "class Widget: pass" };
    const facts = new Map([factsOf("/repo/a.py", ["Widget"]), factsOf("/repo/b.py", ["Widget"])]);
    const g = analyzeRepo(memoryFs(files), "/repo", { facts }).graph;
    expect(g.edges.filter((e) => e.source === "README.md")).toEqual([]);
  });

  it("links docker-compose depends_on to real services via build context, and the compose file to each", () => {
    const files = {
      "docker-compose.yml": ["services:", "  orders:", "    build: ./orders", "    depends_on:", "      - billing", "  billing:", "    build: ./billing"].join("\n"),
      "orders/package.json": "{}",
      "orders/index.ts": "export const orders = 1;",
      "billing/package.json": "{}",
      "billing/index.ts": "export const billing = 1;",
    };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.nodes.find((n) => n.path === "docker-compose.yml")).toMatchObject({ lang: "compose" });
    expect(g.edges).toContainEqual({ source: "orders/index.ts", target: "billing/index.ts" });
    expect(g.edges).toContainEqual({ source: "docker-compose.yml", target: "orders/index.ts" });
    expect(g.edges).toContainEqual({ source: "docker-compose.yml", target: "billing/index.ts" });
  });

  it("skips a depends_on that is not a local build (an image-only service, e.g. a database)", () => {
    const files = {
      "docker-compose.yml": ["services:", "  orders:", "    build: ./orders", "    depends_on:", "      - db", "  db:", "    image: postgres:16"].join("\n"),
      "orders/package.json": "{}",
      "orders/index.ts": "export const orders = 1;",
    };
    const g = analyzeRepo(memoryFs(files), "/repo").graph;
    expect(g.edges).toEqual([{ source: "docker-compose.yml", target: "orders/index.ts" }]);
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

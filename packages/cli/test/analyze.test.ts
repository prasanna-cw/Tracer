import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzePath, serializeGraph } from "../src/analyze";

const demoRoot = fileURLToPath(new URL("../../../samples/demo-repo", import.meta.url));
const r = analyzePath(demoRoot);
const g = r.graph;
const edges = g.edges.map((e) => `${e.source} -> ${e.target}`);

describe("analyzer on samples/demo-repo", () => {
  it("summary has the exact expected counts", () => {
    expect(g.summary).toMatchObject({
      fileCount: 25,
      skippedCount: 1,
      edgeCount: 29,
      unresolvedCount: 3,
      externalCount: 5,
      assetCount: 0,
      cycleCount: 1,
    });
    expect(r.cycleEdges).toBe(3);
    expect(g.root).toBe("demo-repo"); // never an absolute path
  });

  it("finds exactly these edges (deduplicated, sorted)", () => {
    expect(edges).toEqual([
      "src/app.tsx -> src/core/store.ts", // @core/store alias
      "src/app.tsx -> src/features/reports/index.ts", // dynamic import()
      "src/app.tsx -> src/features/widgets/Widget.jsx",
      "src/app.tsx -> src/ui/index.ts", // @ui alias to a barrel
      "src/core/cycle/a.ts -> src/core/cycle/b.ts",
      "src/core/cycle/b.ts -> src/core/cycle/c.ts",
      "src/core/cycle/c.ts -> src/core/cycle/a.ts",
      "src/core/format.ts -> src/core/config.ts",
      "src/core/index.ts -> src/core/format.ts", // export { } from
      "src/core/index.ts -> src/core/store.ts", // export * from
      "src/core/store.ts -> src/core/format.ts",
      "src/features/legacy/bridge.mjs -> src/features/legacy/helper.cjs", // .mjs importing .cjs
      "src/features/legacy/server.cjs -> src/features/legacy/helper.cjs", // require()
      "src/features/reports/chart.js -> src/core/format.ts", // "./format.js" resolves to format.ts
      "src/features/reports/index.ts -> src/core/cycle/a.ts",
      "src/features/reports/index.ts -> src/core/index.ts", // @core alias
      "src/features/reports/index.ts -> src/features/reports/chart.js",
      "src/features/widgets/Widget.jsx -> src/ui/index.ts", // directory import -> index.ts
      "src/main.ts -> src/app.tsx",
      "src/main.ts -> src/features/legacy/bridge.mjs",
      "src/main.ts -> src/utils/index.js", // @utils alias to a .js barrel
      "src/ui/Button.tsx -> src/core/format.ts", // @core/* alias
      "src/ui/Card.jsx -> src/ui/Button.tsx",
      "src/ui/__tests__/Button.test.tsx -> src/ui/Button.tsx",
      "src/ui/index.ts -> src/ui/Button.tsx",
      "src/ui/index.ts -> src/ui/Card.jsx",
      "src/utils/index.js -> src/utils/numbers.js",
      "src/utils/index.js -> src/utils/strings.js",
      "src/utils/numbers.test.ts -> src/utils/numbers.js",
    ]);
  });

  it("lists the unresolvable imports and skips the broken file with a warning", () => {
    expect(g.summary.unresolved).toEqual([
      { from: "src/broken/missing.ts", specifier: "./does-not-exist" },
      { from: "src/broken/missing.ts", specifier: "@core/nope" },
      { from: "src/broken/missing.ts", specifier: "../features/ghost.js" },
    ]);
    expect(g.summary.warnings).toEqual(["src/broken/syntax-error.ts:3: syntax error (Expression expected.); skipped"]);
    expect(g.nodes.map((n) => n.path)).not.toContain("src/broken/syntax-error.ts");
  });

  it("fills node metadata (folder, ext, loc, degrees)", () => {
    const orphans = g.nodes.filter((n) => n.inDegree + n.outDegree === 0).map((n) => n.path);
    expect(orphans).toEqual(["src/broken/missing.ts", "src/orphan.ts"]);
    expect(g.nodes.find((n) => n.path === "src/core/format.ts")).toMatchObject({
      folder: "src/core",
      ext: "ts",
      loc: 3,
      inDegree: 4,
      outDegree: 1,
    });
    expect(new Set(g.nodes.map((n) => n.ext))).toEqual(new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]));
  });

  it("the committed samples/demo-graph.json is up to date (run `npm run analyze:demo` if this fails)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../../../samples/demo-graph.json", import.meta.url)), "utf8");
    expect(committed.replace(/\r\n/g, "\n")).toBe(serializeGraph(r));
  });
});

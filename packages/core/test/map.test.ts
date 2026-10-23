import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { activateMapItem, buildMap, codeGraphSchema, initialMapState, revealInMap, PAGE_SIZE, type CodeGraph, type CodeGraphNode, type DiagramNode } from "../src";

const demo = codeGraphSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../samples/demo-graph.json", import.meta.url)), "utf8")));
const ids = (r: ReturnType<typeof buildMap>) => r.diagram.nodes.map((n) => n.id).sort();
const overlaps = (a: DiagramNode, b: DiagramNode) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const open = (...folders: string[]) => ({ expanded: new Set(folders), pages: new Map<string, number>() });

const synthetic = (paths: string[], edges: [number, number][] = []): CodeGraph => ({
  version: 1,
  root: "synthetic",
  packages: [],
  nodes: paths.map((path): CodeGraphNode => ({ id: path, path, folder: path.slice(0, path.lastIndexOf("/")), ext: "ts", loc: 10, inDegree: 0, outDegree: 0, lang: "typescript" })),
  edges: edges.map(([a, b]) => ({ source: paths[a] as string, target: paths[b] as string })),
  summary: { fileCount: paths.length, skippedCount: 0, edgeCount: edges.length, unresolvedCount: 0, externalCount: 0, assetCount: 0, cycleCount: 0, unresolved: [], warnings: [] },
});

describe("workspace map", () => {
  it("opens on the workspace and its largest folders, not a lone card", () => {
    const r = buildMap(demo, initialMapState(demo));
    expect(r.diagram.nodes.length).toBeGreaterThanOrEqual(8);
    expect(ids(r)).toEqual(expect.arrayContaining(["d:", "d:src", "d:src/core", "d:src/ui"]));
    expect(r.counts.folders).toBeGreaterThan(3);
  });

  it("a collapsed folder stands for everything in it: imports are rolled up with a count", () => {
    const r = buildMap(demo, open("d:", "d:src"));
    const edge = (from: string, to: string) => r.diagram.edges.find((e) => e.fromNode === from && e.toNode === to);
    const brute = (a: string, b: string) => demo.edges.filter((e) => e.source.startsWith(`${a}/`) && e.target.startsWith(`${b}/`)).length;
    for (const [a, b] of [["src/ui", "src/core"], ["src/features", "src/core"], ["src/utils", "src/core"], ["src/features", "src/ui"]] as const) {
      const n = brute(a, b);
      const e = edge(`d:${a}`, `d:${b}`);
      if (n === 0) expect(e, `${a} -> ${b}`).toBeUndefined();
      else expect(e?.label ?? "1", `${a} -> ${b}`).toBe(String(n));
    }
    expect(r.diagram.edges.some((e) => e.fromNode === e.toNode)).toBe(false);
  });

  it("expanding a folder swaps its roll-up for the files and their own links; clicking again collapses", () => {
    const base = open("d:", "d:src");
    const opened = activateMapItem(base, "d:src/ui", { kind: "dir", path: "src/ui" });
    const before = buildMap(demo, base);
    const after = buildMap(demo, opened);
    expect(ids(before)).not.toContain("f:src/ui/Button.tsx");
    expect(ids(after)).toEqual(expect.arrayContaining(["f:src/ui/Button.tsx", "f:src/ui/Card.jsx", "f:src/ui/index.ts"]));
    expect(after.diagram.edges.some((e) => e.fromNode === "f:src/ui/Card.jsx" && e.toNode === "f:src/ui/Button.tsx")).toBe(true);
    expect(activateMapItem(opened, "d:src/ui", { kind: "dir", path: "src/ui" }).expanded.has("d:src/ui")).toBe(false);
    expect(activateMapItem(opened, "f:src/ui/Card.jsx", { kind: "file", path: "src/ui/Card.jsx" })).toBe(opened);
  });

  it("collapses chains of single-child folders into one card", () => {
    const g = synthetic(["a/b/c/d/x.ts", "a/b/c/d/y.ts", "z.ts"]);
    const r = buildMap(g, open("d:", "d:a/b/c/d"));
    expect(r.diagram.nodes.find((n) => n.id === "d:a/b/c/d")?.title).toBe("a/b/c/d");
    expect(r.diagram.nodes.filter((n) => n.id.startsWith("d:"))).toHaveLength(2);
  });

  it("pages big folders: a first page, a '+ N more' card, then the next page on click", () => {
    const g = synthetic(Array.from({ length: 70 }, (_, i) => `big/f${String(i).padStart(2, "0")}.ts`));
    const start = open("d:", "d:big");
    const first = buildMap(g, start);
    expect(first.diagram.nodes.filter((n) => n.id.startsWith("f:"))).toHaveLength(PAGE_SIZE);
    expect(first.diagram.nodes.find((n) => n.id === "m:big")?.title).toBe(`+ ${70 - PAGE_SIZE} more`);
    const second = buildMap(g, activateMapItem(start, "m:big", first.items.get("m:big") ?? { kind: "more", path: "big" }));
    expect(second.diagram.nodes.filter((n) => n.id.startsWith("f:"))).toHaveLength(PAGE_SIZE * 2);
    expect(second.diagram.nodes.find((n) => n.id === "m:big")?.title).toBe(`+ ${70 - PAGE_SIZE * 2} more`);
  });

  it("an import from a file that is paged out is drawn from its folder", () => {
    const paths = Array.from({ length: 40 }, (_, i) => `big/f${String(i).padStart(2, "0")}.ts`).concat(["other/o.ts"]);
    const g = synthetic(paths, [[39, 40]]); // the last big file (not on page 1) -> other/o.ts
    const r = buildMap(g, open("d:", "d:big", "d:other"));
    expect(r.diagram.edges.some((e) => e.fromNode === "d:big" && e.toNode === "f:other/o.ts")).toBe(true);
  });

  it("colours each top-level branch and keeps cards from overlapping", () => {
    const r = buildMap(demo, open("d:", "d:src", "d:src/core", "d:src/ui", "d:src/features"));
    const n = r.diagram.nodes;
    expect(n.flatMap((a, i) => n.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.id}/${b.id}`))).toEqual([]);
    expect(n.find((x) => x.id === "f:src/ui/Button.tsx")?.category).toBe(n.find((x) => x.id === "d:src/ui")?.category);
    expect(r.items.get("f:src/ui/Button.tsx")).toEqual({ kind: "file", path: "src/ui/Button.tsx" });
    expect(n.find((x) => x.id === "f:src/ui/Button.tsx")?.source).toEqual({ path: "src/ui/Button.tsx" });
  });

  it("revealInMap opens the way to a file, even one paged out of a big folder", () => {
    const paths = Array.from({ length: 70 }, (_, i) => `pkg/big/f${String(i).padStart(2, "0")}.ts`).concat(["pkg/x/y.ts"]);
    const g = synthetic(paths);
    const start = initialMapState(g);
    expect(ids(buildMap(g, start))).not.toContain("f:pkg/big/f69.ts");
    const shown = buildMap(g, revealInMap(g, start, "pkg/big/f69.ts"));
    expect(ids(shown)).toContain("f:pkg/big/f69.ts");
    expect(revealInMap(g, start, "nope.ts")).toBe(start);
  });

  it("handles an empty graph", () => {
    const g = synthetic([]);
    expect(buildMap(g, initialMapState(g)).diagram.nodes.map((n) => n.id)).toEqual(["d:"]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeGraphSchema } from "@tracer/core";
import { defaultFilters, groupColors, groupResolver, neighborsOf, searchMatches, visibleNodeIds } from "../src/graph/graphModel";

const demo = codeGraphSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../samples/demo-graph.json", import.meta.url)), "utf8")),
);
const groupOf = groupResolver(demo.nodes.map((n) => n.path));

describe("groupResolver", () => {
  it("groups below the shared prefix (everything in the demo is under src/)", () => {
    expect([groupOf("src/core/format.ts"), groupOf("src/main.ts"), groupOf("src/ui/__tests__/Button.test.tsx")]).toEqual([
      "core",
      "(root)",
      "ui",
    ]);
  });
  it("monorepo: first two levels below the shared root", () => {
    const g = groupResolver(["packages/app/src/a.ts", "packages/core/src/b.ts", "scripts/x.ts", "eslint.config.js"], true);
    expect([g("packages/app/src/a.ts"), g("packages/core/src/b.ts"), g("scripts/x.ts"), g("eslint.config.js")]).toEqual([
      "packages/app",
      "packages/core",
      "scripts",
      "(root)",
    ]);
  });
  it("uses top-level folders when nothing is shared", () => {
    const g = groupResolver(["packages/a/x.ts", "samples/y.ts", "eslint.config.js"]);
    expect([g("packages/a/x.ts"), g("samples/y.ts"), g("eslint.config.js")]).toEqual(["packages", "samples", "(root)"]);
  });
});

describe("visibleNodeIds", () => {
  const all = visibleNodeIds(demo, defaultFilters, groupOf);
  it("shows everything by default", () => expect(all.size).toBe(25));

  it("hides orphans and tests", () => {
    expect(visibleNodeIds(demo, { ...defaultFilters, hideOrphans: true }, groupOf).size).toBe(23);
    const noTests = visibleNodeIds(demo, { ...defaultFilters, hideTests: true }, groupOf);
    expect([...all].filter((id) => !noTests.has(id)).sort()).toEqual(["src/ui/__tests__/Button.test.tsx", "src/utils/numbers.test.ts"]);
  });

  it("hides folders", () => {
    const v = visibleNodeIds(demo, { ...defaultFilters, hiddenGroups: new Set(["core", "features"]) }, groupOf);
    expect([...v].some((id) => id.startsWith("src/core/") || id.startsWith("src/features/"))).toBe(false);
  });

  it("local graph keeps the focus even when another filter would hide it", () => {
    const local = { id: "src/orphan.ts", depth: 2 };
    expect([...visibleNodeIds(demo, { ...defaultFilters, hideOrphans: true, local }, groupOf)]).toEqual(["src/orphan.ts"]);
    const format = visibleNodeIds(demo, { ...defaultFilters, local: { id: "src/core/format.ts", depth: 1 } }, groupOf);
    expect([...format].sort()).toEqual([
      "src/core/config.ts",
      "src/core/format.ts",
      "src/core/index.ts",
      "src/core/store.ts",
      "src/features/reports/chart.js",
      "src/ui/Button.tsx",
    ]);
  });
});

describe("search, colors, neighbors", () => {
  it("searches paths case-insensitively; empty query matches nothing", () => {
    expect(searchMatches(demo.nodes, "CYCLE/").sort()).toEqual(["src/core/cycle/a.ts", "src/core/cycle/b.ts", "src/core/cycle/c.ts"]);
    expect(searchMatches(demo.nodes, "  ")).toEqual([]);
  });
  it("assigns colors by sorted group name, cycling the palette", () => {
    expect([...groupColors(["b", "a", "c", "a"], ["red", "blue"])]).toEqual([["a", "red"], ["b", "blue"], ["c", "red"]]);
  });
  it("lists imports and imported-by", () => {
    expect(neighborsOf(demo, "src/core/store.ts")).toEqual({
      imports: ["src/core/format.ts"],
      importedBy: ["src/app.tsx", "src/core/index.ts"],
    });
  });
});

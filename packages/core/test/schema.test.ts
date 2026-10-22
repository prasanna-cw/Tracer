import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATEGORIES, findUnknownKeys, parseDiagram, resolveCategory, type Diagram } from "../src";
import { readSample } from "./helpers";

const base = (): Diagram => ({
  version: 1,
  title: "t",
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "A" },
    { id: "b", type: "text", x: 0, y: 100, width: 100, height: 50, text: "B" },
  ],
  edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
});

const errorsOf = (input: unknown): string[] => {
  const r = parseDiagram(input);
  return r.ok ? [] : r.errors;
};

describe("diagram schema", () => {
  it("accepts the save-flow sample", () => {
    const r = parseDiagram(readSample("save-flow.diagram.json"));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.value.nodes).toHaveLength(16);
    expect(r.value.steps).toHaveLength(9);
  });

  it("accepts the example in docs/SCHEMA.md", () => {
    const md = readFileSync(fileURLToPath(new URL("../../../docs/SCHEMA.md", import.meta.url)), "utf8");
    const json = /## Example\s+```json\n([\s\S]*?)```/.exec(md)?.[1];
    const r = parseDiagram(JSON.parse(json ?? "null"));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("accepts an empty diagram", () => {
    expect(parseDiagram({ version: 1, title: "", nodes: [], edges: [] }).ok).toBe(true);
  });

  it("accepts a group with no children", () => {
    const d = base();
    d.nodes.push({ id: "g", type: "group", x: 500, y: 500, width: 200, height: 200 });
    expect(parseDiagram(d).ok).toBe(true);
  });

  it("reports missing fields with a readable path", () => {
    const d = base() as unknown as { nodes: Record<string, unknown>[] };
    delete d.nodes[1]!.width;
    expect(errorsOf(d)).toEqual(["nodes[1].width: Invalid input: expected number, received undefined"]);
  });

  it("rejects duplicate node and edge ids", () => {
    const d = base();
    d.nodes.push({ ...d.nodes[0]! });
    d.edges.push({ ...d.edges[0]! });
    expect(errorsOf(d)).toEqual([
      'nodes[2].id: duplicate node id "a"',
      'edges[1].id: duplicate edge id "e1"',
    ]);
  });

  it("rejects edges pointing to missing nodes", () => {
    const d = base();
    d.edges.push({ id: "e2", fromNode: "a", toNode: "ghost" });
    expect(errorsOf(d)).toEqual(['edges[1].toNode: unknown node "ghost"']);
  });

  it("rejects steps referencing unknown nodes or edges", () => {
    const d = base();
    d.steps = [{ id: "s", title: "S", description: "", nodeIds: ["a", "zz"], edgeIds: ["nope"] }];
    expect(errorsOf(d)).toEqual(['steps[0].nodeIds[1]: unknown node "zz"', 'steps[0].edgeIds[0]: unknown edge "nope"']);
  });

  it("validates colors and type-specific fields", () => {
    const d = base();
    d.nodes[0]!.color = "red";
    d.nodes.push({ id: "f", type: "file", x: 0, y: 0, width: 10, height: 10 });
    const errors = errorsOf(d);
    expect(errors[0]).toMatch(/^nodes\[0\]\.color: must be a preset/);
    expect(errors[1]).toBe('nodes[2].file: is required for type "file"');
  });

  it("rejects the wrong version and non-objects", () => {
    expect(errorsOf({ ...base(), version: 2 })).toEqual(["version: must be 1"]);
    expect(errorsOf("nope").length).toBeGreaterThan(0);
  });

  it("preserves unknown fields", () => {
    const d = { ...base(), custom: 1 } as Record<string, unknown>;
    (d.nodes as Record<string, unknown>[])[0]!.zIndex = 5;
    const r = parseDiagram(d);
    expect(r.ok && r.value.custom).toBe(1);
    expect(r.ok && r.value.nodes[0]!.zIndex).toBe(5);
  });

  it("warns (does not fail) on unknown categories, once per value; aliases are silent", () => {
    const d = base();
    d.nodes[0]!.category = "queue";
    d.nodes[1]!.category = "queue";
    d.nodes.push({ id: "c", type: "text", x: 0, y: 300, width: 10, height: 10, category: "Database" });
    const r = parseDiagram(d);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'category "queue" (a, b) is not one of layer, entity, db, service, data, note, warning or a known alias; it gets a fallback color',
    ]);
  });

  it("resolves canonical categories and aliases case-insensitively", () => {
    expect([resolveCategory("db"), resolveCategory("Database"), resolveCategory(" API "), resolveCategory("queue")]).toEqual([
      "db",
      "db",
      "service",
      undefined,
    ]);
    expect(CATEGORIES).toHaveLength(7);
  });

  it("lists keys outside the schema (for dev warnings) without touching meta", () => {
    const d = { ...base(), meta: { anything: 1 }, extra: true } as Diagram;
    (d.nodes[0] as Record<string, unknown>).titel = "typo";
    (d.edges[0] as Record<string, unknown>).weight = 2;
    expect(findUnknownKeys(d)).toEqual(["extra", "nodes[a].titel", "edges[e1].weight"]);
    expect(findUnknownKeys(base())).toEqual([]);
  });

  it("keeps huge label text intact (truncation is a rendering concern)", () => {
    const d = base();
    d.nodes[0]!.text = "x".repeat(50_000);
    expect(parseDiagram(d).ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { Diagram } from "@codemap/core";
import { mergeFlowNodes, paletteOf, toFlowEdges } from "../src/canvas/toFlow";

const d: Diagram = {
  version: 1,
  title: "t",
  nodes: [
    { id: "g", type: "group", x: -10, y: -10, width: 400, height: 300, label: "G" },
    { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, kind: "layer" },
    { id: "b", type: "text", x: 0, y: 200, width: 100, height: 50 },
  ],
  edges: [{ id: "e", fromNode: "a", toNode: "b" }],
};

describe("mergeFlowNodes", () => {
  it("reuses node objects that did not change, so memoized components skip re-rendering", () => {
    const first = mergeFlowNodes([], d, null);
    const moved: Diagram = { ...d, nodes: [d.nodes[0]!, { ...d.nodes[1]!, x: 50 }, d.nodes[2]!] };
    const second = mergeFlowNodes(first, moved, null);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.position).toEqual({ x: 50, y: 0 });
  });

  it("keeps React Flow selection across diagram updates", () => {
    const first = mergeFlowNodes([], d, null).map((n) => (n.id === "a" ? { ...n, selected: true } : n));
    const edited: Diagram = { ...d, nodes: [d.nodes[0]!, { ...d.nodes[1]!, text: "x" }, d.nodes[2]!] };
    expect(mergeFlowNodes(first, edited, null)[1]!.selected).toBe(true);
  });

  it("maps types and puts groups behind", () => {
    const [g, a, b] = mergeFlowNodes([], d, null);
    expect([g!.type, a!.type, b!.type]).toEqual(["cmgroup", "layer", "text"]);
    expect(g!.zIndex).toBe(-1);
  });

  it("dims everything outside the walkthrough step", () => {
    const h = { nodeIds: new Set(["a"]), edgeIds: new Set<string>() };
    expect(mergeFlowNodes([], d, h).map((n) => n.className)).toEqual(["cm-dim", "cm-active", "cm-dim"]);
    expect(toFlowEdges(d, h)[0]!.data!.state).toBe("dim");
  });
});

describe("toFlowEdges", () => {
  it("chooses sides automatically when the edge has none", () => {
    expect(toFlowEdges(d, null)[0]).toMatchObject({ sourceHandle: "s-bottom", targetHandle: "t-top" });
  });
});

describe("paletteOf", () => {
  it("prefers explicit color, then category; unknown categories get a stable known family", () => {
    expect(paletteOf({ color: "5", category: "warning" })).toEqual({ family: "db" });
    expect(paletteOf({ color: "#ff0000" })).toEqual({ family: "plain", hex: "#ff0000" });
    expect(paletteOf({ category: "service" })).toEqual({ family: "service" });
    expect(paletteOf({})).toEqual({ family: "plain" });
    const unknown = paletteOf({ category: "queue" });
    expect(unknown).toEqual(paletteOf({ category: "queue" }));
    expect(unknown.family).not.toBe("plain");
  });
});

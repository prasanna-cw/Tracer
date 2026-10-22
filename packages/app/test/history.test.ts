import { describe, expect, it } from "vitest";
import { moveGroup, type Diagram } from "@codemap/core";
import { historyReducer, initHistory } from "../src/canvas/history";

const d: Diagram = {
  version: 1,
  title: "t",
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "A" },
    { id: "b", type: "text", x: 50, y: 0, width: 10, height: 10, text: "B" },
  ],
  edges: [],
};

describe("history", () => {
  it("moves, edits, undoes and redoes", () => {
    let h = initHistory(d);
    h = historyReducer(h, { type: "move", moves: [{ id: "a", x: 5, y: 6 }] });
    h = historyReducer(h, { type: "edit", id: "b", patch: { text: "B2" } });
    expect(h.present.nodes.map((n) => [n.x, n.text])).toEqual([[5, "A"], [50, "B2"]]);

    h = historyReducer(h, { type: "undo" });
    expect(h.present.nodes[1]!.text).toBe("B");
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(d);
    h = historyReducer(h, { type: "undo" }); // nothing left: no-op
    expect(h.present).toBe(d);

    h = historyReducer(h, { type: "redo" });
    expect(h.present.nodes[0]!.x).toBe(5);
  });

  it("a new change clears the redo stack", () => {
    let h = historyReducer(initHistory(d), { type: "move", moves: [{ id: "a", x: 1, y: 1 }] });
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "edit", id: "a", patch: { text: "new" } });
    expect(h.future).toEqual([]);
  });

  it("ignores no-op moves and edits so they don't create undo steps", () => {
    const h0 = initHistory(d);
    expect(historyReducer(h0, { type: "move", moves: [{ id: "a", x: 0, y: 0 }] })).toBe(h0);
    expect(historyReducer(h0, { type: "edit", id: "a", patch: { text: "A" } })).toBe(h0);
    expect(historyReducer(h0, { type: "edit", id: "missing", patch: { text: "x" } })).toBe(h0);
  });

  it("tracks dirty state against the last save, including undo back to it", () => {
    let h = initHistory(d);
    h = historyReducer(h, { type: "move", moves: [{ id: "a", x: 1, y: 1 }] });
    expect(h.present !== h.saved).toBe(true);
    h = historyReducer(h, { type: "saved", diagram: h.present });
    expect(h.present === h.saved).toBe(true);
    h = historyReducer(h, { type: "undo" });
    expect(h.present !== h.saved).toBe(true);
  });

  it("dragging a group moves its members, and one undo restores all of them", () => {
    const g: Diagram = {
      ...d,
      nodes: [{ id: "g", type: "group", x: -5, y: -5, width: 100, height: 40 }, ...d.nodes],
    };
    let h = initHistory(g);
    h = historyReducer(h, { type: "move", moves: moveGroup(g.nodes, "g", 95, 195) });
    expect(h.present.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ["g", 95, 195],
      ["a", 100, 200],
      ["b", 150, 200],
    ]);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(g);
    expect(h.past).toEqual([]);
  });

  it("only reallocates nodes that changed (keeps memoized node components cheap)", () => {
    const h = historyReducer(initHistory(d), { type: "move", moves: [{ id: "a", x: 9, y: 9 }] });
    expect(h.present.nodes[1]).toBe(d.nodes[1]);
  });
});

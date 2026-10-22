import { describe, expect, it } from "vitest";
import { chooseSides, parseDiagram, type Diagram, type DiagramNode, type Side } from "../src";
import { readSample } from "./helpers";

const r = parseDiagram(readSample("save-flow.diagram.json"));
if (!r.ok) throw new Error(r.errors.join("\n"));
const d: Diagram = r.value;
const node = (id: string): DiagramNode => d.nodes.find((n) => n.id === id)!;
const cells = (row: string): string[] => row.split(" | ");
const body = (id: string): string[][] => node(id).rows!.filter((x) => !x.muted).map((x) => cells(x.text));

describe("save-flow sample: data consistency", () => {
  // Input columns: Risk # | Description | Probability | Impact | Tags | Actions
  const risks = body("input").map(([no, description, probability, impact, tags, actions], i) => ({
    id: String(i + 1),
    no: no!,
    cells: { description: description!, probability: probability!, impact: impact! },
    tags: tags!.split(", "),
    actions: actions!.split("; "),
  }));

  it("risk_record has one row per input risk", () => {
    expect(body("tbl-record")).toEqual(risks.map((k) => [k.id, "7", k.no]));
  });

  it("risk_cell_value has every cell value of every risk", () => {
    expect(body("tbl-cells")).toEqual(risks.flatMap((k) => Object.entries(k.cells).map(([col, v]) => [k.id, col, v])));
  });

  it("risk_tag and risk_action match the input tags and actions", () => {
    expect(body("tbl-tags")).toEqual(risks.flatMap((k) => k.tags.map((t) => [k.id, t])));
    expect(body("tbl-actions")).toEqual(risks.flatMap((k) => k.actions.map((a, i) => [k.id, String(i + 1), a])));
  });
});

// Mirrors React Flow's getBezierPath (curvature 0.3, as DiagramEdge passes) closely enough to catch overlaps.
type P = { x: number; y: number };
const anchor = (n: DiagramNode, s: Side): P =>
  ({
    top: { x: n.x + n.width / 2, y: n.y },
    bottom: { x: n.x + n.width / 2, y: n.y + n.height },
    left: { x: n.x, y: n.y + n.height / 2 },
    right: { x: n.x + n.width, y: n.y + n.height / 2 },
  })[s];
const offset = (dist: number): number => (dist >= 0 ? 0.5 * dist : 0.3 * 25 * Math.sqrt(-dist));
const control = (p: P, s: Side, other: P): P =>
  ({
    top: { x: p.x, y: p.y - offset(p.y - other.y) },
    bottom: { x: p.x, y: p.y + offset(other.y - p.y) },
    left: { x: p.x - offset(p.x - other.x), y: p.y },
    right: { x: p.x + offset(other.x - p.x), y: p.y },
  })[s];
function bezier(from: DiagramNode, to: DiagramNode, sides: { fromSide: Side; toSide: Side }): P[] {
  const p0 = anchor(from, sides.fromSide);
  const p3 = anchor(to, sides.toSide);
  const p1 = control(p0, sides.fromSide, p3);
  const p2 = control(p3, sides.toSide, p0);
  return Array.from({ length: 51 }, (_, i) => {
    const t = i / 50;
    const u = 1 - t;
    return {
      x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
      y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y,
    };
  });
}
const inside = (p: P, n: DiagramNode, pad = 2): boolean =>
  p.x > n.x + pad && p.x < n.x + n.width - pad && p.y > n.y + pad && p.y < n.y + n.height - pad;

function crossings(dg: Diagram): string[] {
  const byId = new Map(dg.nodes.map((n) => [n.id, n]));
  return dg.edges.flatMap((e) => {
    const from = byId.get(e.fromNode)!;
    const to = byId.get(e.toNode)!;
    const path = bezier(from, to, chooseSides(from, to, e));
    return dg.nodes
      .filter((n) => n.type !== "group" && n.id !== from.id && n.id !== to.id)
      .filter((n) => path.some((p) => inside(p, n)))
      .map((n) => `${e.id} crosses ${n.id}`);
  });
}

describe("save-flow sample: layout", () => {
  it("no edge passes through a card it does not connect (groups are containers, not cards)", () => {
    expect(crossings(d)).toEqual([]);
  });

  it("the crossing check catches a card placed on an edge", () => {
    const blocker: DiagramNode = { id: "blocker", type: "text", x: 540, y: 470, width: 40, height: 40 };
    expect(crossings({ ...d, nodes: [...d.nodes, blocker] })).toEqual(["e-ctrl-svc crosses blocker"]);
  });

  it("entity -> flush edges leave from the bottom with a clear gap", () => {
    const flush = node("flush");
    for (const e of d.edges.filter((x) => x.toNode === "flush")) {
      expect([e.fromSide, e.toSide]).toEqual(["bottom", "top"]);
      const from = node(e.fromNode);
      expect(flush.y - (from.y + from.height)).toBeGreaterThanOrEqual(100);
    }
  });

  it("cards do not overlap each other", () => {
    const cards = d.nodes.filter((n) => n.type !== "group");
    const overlaps = cards.flatMap((a, i) =>
      cards
        .slice(i + 1)
        .filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
        .map((b) => `${a.id} overlaps ${b.id}`),
    );
    expect(overlaps).toEqual([]);
  });
});

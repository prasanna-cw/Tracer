import { describe, expect, it } from "vitest";
import { fromJsonCanvas, hashText, parseDiagram, parseRichMarkdown, toJsonCanvas, type Diagram } from "../src";
import { readSample } from "./helpers";

const saveFlow = (): Diagram => {
  const r = parseDiagram(readSample("save-flow.diagram.json"));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};

const roundTrip = (d: Diagram): Diagram => {
  // Through a real JSON string, as it would be on disk.
  const r = fromJsonCanvas(JSON.parse(JSON.stringify(toJsonCanvas(d))));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};

const byId = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));

describe("JSON Canvas export", () => {
  it("produces spec-valid nodes (text on every text node, integer geometry, groups first)", () => {
    const canvas = toJsonCanvas(saveFlow());
    for (const n of canvas.nodes) {
      for (const k of ["x", "y", "width", "height"]) expect(Number.isInteger(n[k])).toBe(true);
      if (n.type === "text") expect(typeof n.text).toBe("string");
      expect(n).not.toHaveProperty("rows");
      expect(n).not.toHaveProperty("kind");
    }
    expect(canvas.nodes[0]!.type).toBe("group");
  });

  it("flattens rich nodes to markdown", () => {
    const service = byId(toJsonCanvas(saveFlow()).nodes as { id: string; text?: string }[])["service"]!;
    expect(service.text).toBe(
      [
        "## Service layer",
        "*RiskService.save() · @Transactional*",
        "- One transaction for the whole save\n- Load existing records, tags and actions once, before the loop\n- Per risk: saveAll() for each child collection\n- One flush per risk record",
      ].join("\n\n"),
    );
  });

  it("maps known categories to Obsidian preset colors without persisting them", () => {
    const d = saveFlow();
    const exported = byId(toJsonCanvas(d).nodes as { id: string; color?: string }[]);
    expect(exported["tbl-record"]!.color).toBe("5");
    expect(roundTrip(d).nodes.find((n) => n.id === "tbl-record")!.color).toBeUndefined();
  });

  it("writes the document tracer block only when Tracer data needs it", () => {
    const plain: Diagram = { version: 1, title: "t", nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "" }], edges: [] };
    expect(toJsonCanvas(plain)).not.toHaveProperty("tracer");
    expect(toJsonCanvas({ ...plain, meta: { k: 1 } })).toHaveProperty("tracer", { version: 1, title: "t", meta: { k: 1 } });
    const rich: Diagram = { ...plain, nodes: [{ ...plain.nodes[0]!, kind: "note" }] };
    expect(toJsonCanvas(rich)).toHaveProperty("tracer.title", "t");
  });

  it("maps category aliases to the same Obsidian preset", () => {
    const n = { id: "a", type: "text" as const, x: 0, y: 0, width: 10, height: 10, category: "Database" };
    expect(toJsonCanvas({ version: 1, title: "t", nodes: [n], edges: [] }).nodes[0]!.color).toBe("5");
  });

  it("rounds fractional geometry from dragging", () => {
    const d: Diagram = { version: 1, title: "t", nodes: [{ id: "a", type: "text", x: 1.4, y: 2.6, width: 99.5, height: 50, text: "" }], edges: [] };
    expect(toJsonCanvas(d).nodes[0]).toMatchObject({ x: 1, y: 3, width: 100, height: 50 });
  });
});

describe("JSON Canvas round-trip", () => {
  it("is lossless for our own diagrams (geometry, edges, labels, groups, rich fields, steps)", () => {
    const d = saveFlow();
    const back = roundTrip(d);
    // Order differs only by groups being moved first; compare by id.
    expect(byId(back.nodes)).toEqual(byId(d.nodes));
    expect(back.edges).toEqual(d.edges);
    expect(back.steps).toEqual(d.steps);
    expect(back.title).toBe(d.title);
  });

  it("round-trips the plain Obsidian sample", () => {
    const raw = readSample("architecture.canvas");
    const first = fromJsonCanvas(raw, { title: "Architecture" });
    if (!first.ok) throw new Error(first.errors.join("\n"));
    expect(first.value.title).toBe("Architecture");
    expect(first.value.nodes).toHaveLength(7);
    expect(byId(roundTrip(first.value).nodes)).toEqual(byId(first.value.nodes));
    // A plain canvas exports exactly as it came in: no top-level tracer block.
    expect(toJsonCanvas(first.value)).toEqual(raw);
    expect(toJsonCanvas(first.value)).not.toHaveProperty("tracer");
  });

  it("keeps unknown fields on nodes, edges and the document", () => {
    const r = fromJsonCanvas({
      nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "hi", future: { z: 1 } }],
      edges: [],
      plugin: "x",
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.value.nodes[0]!.future).toEqual({ z: 1 });
    expect(r.value.plugin).toBe("x");
    expect(toJsonCanvas(r.value).plugin).toBe("x");
  });

  it("an unedited export -> import changes nothing and warns about nothing", () => {
    const d = saveFlow();
    const r = fromJsonCanvas(JSON.parse(JSON.stringify(toJsonCanvas(d))));
    expect(r).toEqual({ ok: true, value: d, warnings: [] });
  });

  it("stores a hash of the generated markdown on rich nodes", () => {
    const svc = toJsonCanvas(saveFlow()).nodes.find((n) => n.id === "service")!;
    expect((svc.tracer as { textHash: string }).textHash).toBe(hashText(svc.text as string));
  });
});

describe("edits made outside CodeMap", () => {
  const editService = (text: string) => {
    const canvas = toJsonCanvas(saveFlow());
    canvas.nodes.find((n) => n.id === "service")!.text = text;
    const r = fromJsonCanvas(JSON.parse(JSON.stringify(canvas)));
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return { node: r.value.nodes.find((n) => n.id === "service")!, warnings: r.warnings };
  };

  it("re-reads title, subtitle, text and rows from edited markdown", () => {
    const { node, warnings } = editService("## Service v2\n\n*save()*\n\nNow async.\n\n- One transaction\n- *Retry on deadlock*");
    expect(node).toMatchObject({
      kind: "layer",
      title: "Service v2",
      subtitle: "save()",
      text: "Now async.",
      rows: [{ text: "One transaction" }, { text: "Retry on deadlock", muted: true }],
      source: { path: "src/main/java/app/risk/RiskService.java", line: 88 },
    });
    expect(warnings).toEqual([
      'Node "service": edited outside CodeMap; title, subtitle, text and rows re-read from its markdown',
    ]);
  });

  it("falls back to a plain note when the markdown lost its shape", () => {
    const { node, warnings } = editService("Just a sentence now.");
    expect(node.kind).toBe("note");
    expect(node.text).toBe("Just a sentence now.");
    expect(node.title).toBeUndefined();
    expect(node.rows).toBeUndefined();
    expect(node.category).toBe("service");
    expect(warnings).toEqual([
      'Node "service": edited outside CodeMap and no longer has a heading or list; kept as a plain note',
    ]);
  });

  it("mutes the first row of table kinds even without italics", () => {
    expect(parseRichMarkdown("## t\n\n- a | b\n- 1 | 2", true)?.rows).toEqual([{ text: "a | b", muted: true }, { text: "1 | 2" }]);
    expect(parseRichMarkdown("## t\n\n- a\n- b", false)?.rows).toEqual([{ text: "a" }, { text: "b" }]);
  });
});

describe("real output of an external editor (Obsidian): save-flow.edited-externally.canvas", () => {
  // The external editor deleted ent-actions (and its two edges) and the input card's heading was edited.
  const r = fromJsonCanvas(readSample("save-flow.edited-externally.canvas"));

  it("imports without errors", () => {
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("picks up the edited heading and keeps the table rows", () => {
    if (!r.ok) return;
    const input = r.value.nodes.find((n) => n.id === "input")!;
    expect(input.title).toBe("Risk register testing (form input)");
    // The fixture is frozen Obsidian output: compare with the rows it carried, not the (evolving) sample.
    const raw = readSample("save-flow.edited-externally.canvas") as { nodes: { id: string; codemap?: { rows?: unknown } }[] };
    expect(input.rows).toEqual(raw.nodes.find((n) => n.id === "input")!.codemap!.rows);
    expect(input.kind).toBe("table");
    expect(input.color).toBeUndefined(); // derived preset color not persisted
  });

  it("has 15 nodes and no dangling references", () => {
    if (!r.ok) return;
    const d = r.value;
    expect(d.nodes).toHaveLength(15);
    const nodeIds = new Set(d.nodes.map((n) => n.id));
    const edgeIds = new Set(d.edges.map((e) => e.id));
    for (const e of d.edges) expect([nodeIds.has(e.fromNode), nodeIds.has(e.toNode)]).toEqual([true, true]);
    for (const s of d.steps ?? []) {
      expect(s.nodeIds.every((id) => nodeIds.has(id))).toBe(true);
      expect((s.edgeIds ?? []).every((id) => edgeIds.has(id))).toBe(true);
    }
    expect(d.steps).toHaveLength(9);
    expect(d.steps?.find((s) => s.id === "s5")?.nodeIds).toEqual(["ent-record", "ent-cells", "ent-tags"]);
  });

  it("explains every repair, naming steps by title and id", () => {
    expect(r.warnings).toEqual([
      'Node "input": edited outside CodeMap; title, subtitle, text and rows re-read from its markdown',
      'Step "Entities per risk" (s5): removed missing node ent-actions',
      'Step "Entities per risk" (s5): removed missing edge e-svc-actions',
      'Step "Flush once per risk" (s6): removed missing edge e-actions-flush',
    ]);
  });
});

describe("step repair", () => {
  it("drops a step whose nodes are all gone", () => {
    const r = fromJsonCanvas({
      nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "" }],
      edges: [],
      codemap: {
        title: "t",
        steps: [
          { id: "s1", title: "Keep", description: "", nodeIds: ["a"] },
          { id: "s2", title: "Gone", description: "", nodeIds: ["x", "y"] },
        ],
      },
    });
    expect(r.ok && r.value.steps?.map((s) => s.id)).toEqual(["s1"]);
    expect(r.warnings).toEqual([
      'Step "Gone" (s2): removed missing node x',
      'Step "Gone" (s2): removed missing node y',
      'Step "Gone" (s2): dropped, none of its nodes remain',
    ]);
  });
});

describe("JSON Canvas import errors", () => {
  it("rejects non-objects and bad arrays with clear messages", () => {
    expect(fromJsonCanvas(null)).toEqual({ ok: false, errors: ["JSON Canvas must be a JSON object"], warnings: [] });
    expect(fromJsonCanvas({ nodes: {} })).toEqual({ ok: false, errors: ["nodes: must be an array"], warnings: [] });
  });

  it('does not throw on malformed stash blocks (legacy "codemap" key)', () => {
    const r = fromJsonCanvas({
      nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "x", codemap: { rows: "nope", text: null } }],
      codemap: { steps: "nope" },
    });
    expect(r.ok).toBe(false); // reported as validation errors, not exceptions
  });

  it("treats an empty object as an empty canvas", () => {
    const r = fromJsonCanvas({});
    expect(r.ok && r.value.nodes).toEqual([]);
  });

  it("reports dangling edges from hand-edited files", () => {
    const r = fromJsonCanvas({ nodes: [], edges: [{ id: "e", fromNode: "a", toNode: "b" }] });
    expect(r.ok ? [] : r.errors).toEqual(['edges[0].fromNode: unknown node "a"', 'edges[0].toNode: unknown node "b"']);
  });
});

import { describe, expect, it } from "vitest";
import {
  diagramToText,
  errorResponse,
  hostEvent,
  okResponse,
  parseResult,
  parseToHost,
  parseToWebview,
  textToDiagram,
  type Diagram,
} from "../src";

const diagram: Diagram = { version: 1, title: "t", nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "hi" }], edges: [] };
const errorsOf = (r: { ok: boolean; errors?: string[] }) => (r.ok ? [] : (r.errors ?? []));

describe("webview -> extension (requests)", () => {
  it("accepts every well-formed request and types its params", () => {
    const r = parseToHost({ kind: "request", id: 7, method: "openSource", params: { path: "src/a.ts", line: 3 } });
    expect(r.ok && r.value).toEqual({ kind: "request", id: 7, method: "openSource", params: { path: "src/a.ts", line: 3 } });
    expect(parseToHost({ kind: "request", id: 1, method: "init", params: {} }).ok).toBe(true);
    expect(parseToHost({ kind: "request", id: 2, method: "applyEdit", params: { id: "x.diagram.json", diagram } }).ok).toBe(true);
  });

  it("treats missing params as {} for parameterless methods", () => {
    expect(parseToHost({ kind: "request", id: 1, method: "loadGraph" }).ok).toBe(true);
  });

  it("rejects unknown methods, bad envelopes and bad params with readable paths", () => {
    expect(errorsOf(parseToHost({ kind: "request", id: 1, method: "deleteEverything", params: {} }))[0]).toMatch(/^method: /);
    expect(errorsOf(parseToHost({ kind: "response", id: 1 })).length).toBeGreaterThan(0);
    expect(errorsOf(parseToHost("hello")).length).toBeGreaterThan(0);
    expect(errorsOf(parseToHost({ kind: "request", id: -1, method: "init", params: {} }))[0]).toMatch(/^id: /);
    expect(errorsOf(parseToHost({ kind: "request", id: 1, method: "openSource", params: { path: "" } }))[0]).toMatch(/^params\.path: /);
  });

  it("validates diagrams inside requests (a broken diagram never reaches the document)", () => {
    const bad = { ...diagram, edges: [{ id: "e", fromNode: "a", toNode: "ghost" }] };
    expect(errorsOf(parseToHost({ kind: "request", id: 1, method: "applyEdit", params: { id: "x", diagram: bad } }))).toEqual([
      'params.diagram.edges[0].toNode: unknown node "ghost"',
    ]);
  });

  it("only accepts plain file names for exports (no paths)", () => {
    const req = (filename: string) => parseToHost({ kind: "request", id: 1, method: "exportFile", params: { filename, data: "", encoding: "utf8" } });
    expect(req("diagram.png").ok).toBe(true);
    for (const f of ["../x.png", "a/b.png", "C:\\x.png", ""]) expect(req(f).ok).toBe(false);
  });
});

describe("extension -> webview (responses and events)", () => {
  it("round-trips responses; results are validated per method", () => {
    const res = okResponse(3, "loadDiagram", diagram);
    const parsed = parseToWebview(JSON.parse(JSON.stringify(res)));
    expect(parsed.ok && parsed.value).toMatchObject({ kind: "response", id: 3, ok: true });
    expect(parseResult("loadDiagram", (res as { result: unknown }).result).ok).toBe(true);
    expect(errorsOf(parseResult("loadGraph", { nodes: [] })).length).toBeGreaterThan(0);
    expect(parseResult("saveDiagram", null).ok).toBe(true);
  });

  it("builds error responses and events", () => {
    expect(parseToWebview(errorResponse(4, "nope")).ok).toBe(true);
    expect(parseToWebview(hostEvent({ kind: "event", type: "theme", theme: "obsidian" })).ok).toBe(true);
    expect(parseToWebview(hostEvent({ kind: "event", type: "documentInvalid", id: "x", errors: ["bad"] })).ok).toBe(true);
  });

  it("refuses to send malformed messages from the extension (bugs fail loudly)", () => {
    expect(() => okResponse(1, "loadDiagram", { nope: true } as unknown as Diagram)).toThrow();
    expect(() => hostEvent({ kind: "event", type: "theme", theme: "neon" } as never)).toThrow();
  });

  it("rejects unknown events and malformed responses", () => {
    expect(parseToWebview({ kind: "event", type: "eval", code: "x" }).ok).toBe(false);
    expect(parseToWebview({ kind: "response", id: 1, ok: true }).ok).toBe(true); // result checked separately
    expect(parseToWebview({ kind: "response", id: 1, ok: false }).ok).toBe(false); // error message required
  });
});

describe("document text <-> diagram", () => {
  it("round-trips native and JSON Canvas documents by file name", () => {
    for (const name of ["a.diagram.json", "b.canvas"]) {
      const r = textToDiagram(name, diagramToText(name, diagram));
      expect(r.ok && r.value.nodes).toEqual(diagram.nodes);
    }
    expect(diagramToText("b.canvas", diagram)).toContain('\t"nodes"'); // Obsidian's tab indentation
  });

  it("reports invalid JSON and invalid diagrams instead of throwing; tolerates a BOM", () => {
    expect(errorsOf(textToDiagram("a.diagram.json", "{ nope"))[0]).toMatch(/^not valid JSON: /);
    expect(errorsOf(textToDiagram("a.diagram.json", "{}")).length).toBeGreaterThan(0);
    expect(textToDiagram("a.diagram.json", "\uFEFF" + diagramToText("a.diagram.json", diagram)).ok).toBe(true);
  });
});

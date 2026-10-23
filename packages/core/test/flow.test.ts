import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFunctionIndex, callTrace, Engine, fileOverview, languageForPath, type FunctionIndex, type IndexedFile } from "../src/engine";
import type { Diagram, DiagramNode } from "../src";
import { SAMPLES } from "./flowSamples";
import { nodeWasm } from "./wasm";

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.create(nodeWasm);
});

const noCalls = () => undefined;
const count = (d: Diagram, kind: string, subtitle?: string): number => d.nodes.filter((n) => n.kind === kind && (subtitle === undefined || n.subtitle === subtitle)).length;
const overlaps = (a: DiagramNode, b: DiagramNode): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("function flow, every language", () => {
  it.each(SAMPLES)("$lang: loops, branches, try/catch, returns", async (s) => {
    const r = await engine.flow(s.file, s.code, { kind: "function", line: s.line }, noCalls);
    if (!r.ok) throw new Error(r.reason);
    const d = r.diagram;
    expect(count(d, "start")).toBe(1);
    expect(count(d, "decision", "loop"), "loops").toBe(s.want.loops);
    expect(count(d, "decision", "if"), "ifs").toBe(s.want.ifs);
    expect(count(d, "decision", "try"), "tries").toBe(s.want.tries);
    expect(count(d, "decision", "catch"), "catches").toBe(s.want.catches);
    expect(count(d, "decision", "switch"), "switches").toBe(s.want.switches ?? 0);
    expect(count(d, "end"), "ends").toBe(s.want.ends);
    // Valid for the rest of the product: parses as a Diagram, every edge points at a node, ends have no exits.
    const ids = new Set(d.nodes.map((n) => n.id));
    expect(d.edges.every((e) => ids.has(e.fromNode) && ids.has(e.toNode))).toBe(true);
    const ends = new Set(d.nodes.filter((n) => n.kind === "end").map((n) => n.id));
    expect(d.edges.some((e) => ends.has(e.fromNode))).toBe(false);
  });

  it("lays every flow out without overlapping cards", async () => {
    for (const s of SAMPLES) {
      const r = await engine.flow(s.file, s.code, { kind: "function", line: s.line }, noCalls);
      if (!r.ok) throw new Error(`${s.lang}: ${r.reason}`);
      const n = r.diagram.nodes;
      const clashes = n.flatMap((a, i) => n.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${s.lang}: ${a.title} / ${b.title}`));
      expect(clashes).toEqual([]);
    }
  });
});

describe("flow semantics", () => {
  const ts = (body: string) => `function f(x) {\n${body}\n}`;
  const flow = async (code: string, req: Parameters<Engine["flow"]>[2] = { kind: "function", line: 2 }) => {
    const r = await engine.flow("f.ts", code, req, noCalls);
    if (!r.ok) throw new Error(r.reason);
    return r;
  };
  const edgesOf = (d: Diagram) => d.edges.map((e) => `${d.nodes.find((n) => n.id === e.fromNode)?.title} -${e.label ?? ""}-> ${d.nodes.find((n) => n.id === e.toNode)?.title}`);

  it("an if without else falls through on 'no'; the then branch falls through too", async () => {
    const { diagram } = await flow(ts("if (a) { b(); }\nc();"));
    expect(edgesOf(diagram).sort()).toEqual(["a -no-> c()", "a -yes-> b()", "b() --> c()", "f --> a"]);
  });

  it("code after return is unreachable and not drawn", async () => {
    const { diagram } = await flow(ts("a();\nreturn 1;\nb();"));
    expect(diagram.nodes.map((n) => n.title)).toEqual(["f", "a()", "1"]);
  });

  it("a loop gets a dashed back-edge from its last step and a 'done' exit", async () => {
    const { diagram } = await flow(ts("for (const i of xs) { a(i); }\nb();"));
    const back = diagram.edges.find((e) => e.style === "dashed");
    expect(back && [diagram.nodes.find((n) => n.id === back.fromNode)?.title, diagram.nodes.find((n) => n.id === back.toNode)?.subtitle]).toEqual(["a(i)", "loop"]);
    expect(edgesOf(diagram)).toContain("for (const i of xs) -done-> b()");
  });

  it("merges consecutive call-free statements into one card", async () => {
    const { diagram } = await flow(ts("const a = 1;\nconst b = 2;\nconst c = 3;\nrun();"));
    expect(diagram.nodes.map((n) => n.title)).toEqual(["f", "3 statements", "run()"]);
  });

  it("a selection draws only the statements it touches, from the innermost block", async () => {
    const code = ts("a();\nif (x) {\n  b();\n  c();\n  d();\n}\ne();");
    const { diagram } = await flow(code, { kind: "selection", startLine: 4, endLine: 5 });
    expect(diagram.nodes.map((n) => n.title)).toEqual(["Lines 4–5", "b()", "c()"]);
    expect(diagram.title).toContain("lines 4–5");
  });

  it("caps huge functions and says so", async () => {
    const r = await flow(ts(Array.from({ length: 150 }, (_, i) => `call${i}();`).join("\n")));
    expect(r.truncated).toBe(true);
    expect(r.diagram.nodes.length).toBeLessThanOrEqual(82);
    expect(r.diagram.nodes.at(-1)?.title).toBe("More steps not shown");
  });

  it("reports a missing function or an unsupported file instead of throwing", async () => {
    expect(await engine.flow("f.ts", "const x = 1;\n", { kind: "function", line: 1 }, noCalls)).toEqual({ ok: false, reason: "There is no function at the cursor." });
    expect((await engine.flow("notes.md", "# hi", { kind: "function", line: 1 }, noCalls)).ok).toBe(false);
    expect((await engine.flow("f.ts", "const x = 1;\n", { kind: "selection", startLine: 9, endLine: 9 }, noCalls)).ok).toBe(false);
  });
});

// ---- cross-file: the polyglot workspace --------------------------------------------------------------------------

const polyglot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../samples/polyglot");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

describe("calls followed across files (samples/polyglot)", () => {
  let index: FunctionIndex;
  const files = new Map<string, IndexedFile>();
  const text = (p: string) => readFileSync(join(polyglot, p), "utf8");
  const CONTROLLER = "orders-java/src/main/java/com/acme/orders/web/OrderController.java";
  const SERVICE = "orders-java/src/main/java/com/acme/orders/service/OrderService.java";

  beforeAll(async () => {
    for (const abs of walk(polyglot)) {
      const path = relative(polyglot, abs).split("\\").join("/");
      if (!languageForPath(path)) continue;
      const facts = await engine.facts(path, readFileSync(abs, "utf8"));
      if (facts) files.set(path, { path, facts, service: path.split("/")[0] ?? "" });
    }
    index = buildFunctionIndex(files.values());
  }, 60_000);

  it("resolves a call through the receiver's type, not just the method name", () => {
    expect(index.resolve("service.place", { path: CONTROLLER, container: "OrderController" })).toEqual({ path: SERVICE, line: 13, name: "place", container: "OrderService" });
    expect(index.resolve("repo.save", { path: SERVICE, container: "OrderService" })).toMatchObject({ container: "OrderRepository", name: "save" });
    expect(index.resolve("new Order", { path: SERVICE, container: "OrderService" })).toMatchObject({ name: "Order" });
  });

  it("does not guess when a name is ambiguous or common", () => {
    expect(index.resolve("log.warn", { path: SERVICE })).toBeUndefined();
    expect(index.resolve("anything.get", { path: SERVICE })).toBeUndefined();
    expect(index.resolve("x.doesNotExist", { path: SERVICE })).toBeUndefined();
  });

  it("a function flow links its calls to their definitions (card opens the callee)", async () => {
    const r = await engine.flow(CONTROLLER, text(CONTROLLER), { kind: "function", line: 14 }, index.resolve);
    if (!r.ok) throw new Error(r.reason);
    const step = r.diagram.nodes.find((n) => n.title?.includes("service.place"));
    expect(step?.source).toEqual({ path: SERVICE, line: 13 });
    expect(step?.rows?.[0]?.text).toBe(`→ OrderService.place  ${SERVICE}:13`);
    expect(step?.kind).toBe("end"); // `return service.place(...)` is a return that links to its callee
    expect(r.diagram.nodes.some((n) => n.kind === "decision" && n.subtitle === "if" && n.title === "qty <= 0")).toBe(true);
  });

  it("call trace follows Controller -> Service -> Repository across files", () => {
    const t = callTrace(index, { path: CONTROLLER, line: 14 }, 4);
    if (!t.ok) throw new Error(t.reason);
    const titles = t.diagram.nodes.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["OrderController.place", "OrderService.place", "OrderRepository.save", "OrderRepository.rollback", "Order.id"]));
    const byTitle = (s: string) => t.diagram.nodes.find((n) => n.title === s);
    expect(t.diagram.edges.some((e) => e.fromNode === byTitle("OrderController.place")?.id && e.toNode === byTitle("OrderService.place")?.id)).toBe(true);
    // Colors by architectural role.
    expect([byTitle("OrderController.place")?.category, byTitle("OrderService.place")?.category, byTitle("OrderRepository.save")?.category]).toEqual(["layer", "service", "db"]);
    expect(t.diagram.nodes.find((n) => n.kind === "start")?.title).toBe("OrderController.place");
  });

  it("depth limits the trace", () => {
    const t = callTrace(index, { path: CONTROLLER, line: 14 }, 1);
    if (!t.ok) throw new Error(t.reason);
    expect(t.diagram.nodes.map((n) => n.title).sort()).toEqual(["OrderController.place", "OrderService.place"]);
  });

  it("file overview: functions of a file, what calls what inside it, and what it reaches elsewhere", () => {
    const o = fileOverview(files.get(SERVICE) as IndexedFile, index);
    if (!o.ok) throw new Error(o.reason);
    const titles = o.diagram.nodes.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["Imports", "OrderService.OrderService", "OrderService.place", "OrderRepository.save", "OrderRepository.rollback"]));
    const external = o.diagram.nodes.filter((n) => n.title?.startsWith("OrderRepository"));
    expect(external.every((n) => n.kind === "note")).toBe(true);
    const n = o.diagram.nodes;
    expect(n.flatMap((a, i) => n.slice(i + 1).filter((b) => overlaps(a, b)))).toEqual([]);
  });

  it("file overview reports a file with nothing to show", () => {
    const empty: IndexedFile = { path: "x.ts", service: "", facts: { lang: "typescript", loc: 1, imports: [], types: [], functions: [], typeRefs: [], syntaxErrors: false } };
    expect(fileOverview(empty, index)).toEqual({ ok: false, reason: "x.ts declares no functions or types." });
  });
});

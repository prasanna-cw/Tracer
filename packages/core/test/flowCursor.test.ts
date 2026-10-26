import { beforeAll, describe, expect, it } from "vitest";
import { buildFunctionIndex, callTrace, Engine, fileOverview } from "../src/engine";
import type { Diagram } from "../src";
import { layoutFlow } from "../src/layout/flowLayout";
import { nodeWasm } from "./wasm";

// Regressions for "Show Flow does nothing": every place the cursor or a selection used to find no function,
// or a function whose flow came out empty.

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.create(nodeWasm);
});

const noCalls = () => undefined;
const lines = (...l: string[]) => l.join("\n");
const titles = (d: Diagram) => d.nodes.map((n) => n.title);
async function flowAt(file: string, code: string, line: number, column?: number) {
  const r = await engine.flow(file, code, { kind: "function", line, column }, noCalls);
  if (!r.ok) throw new Error(`${file}:${line}: ${r.reason}`);
  return r;
}

describe("nameless functions are functions", () => {
  const routes = lines(
    "const app = express();",
    "app.get('/orders/:id', async (req, res) => {",
    "  if (!req.params.id) { return res.status(400).end(); }",
    "  res.json(await load(req.params.id));",
    "});",
  );

  it("an Express route handler, from its body and from its first line", async () => {
    for (const line of [2, 3, 4]) {
      const r = await flowAt("routes.ts", routes, line);
      expect(r.diagram.nodes[0]?.title).toBe("app.get '/orders/:id' callback");
      expect(r.diagram.nodes.some((n) => n.kind === "decision")).toBe(true);
    }
  });

  it("a wrapped React component takes the variable's name; a hook callback is its own flow", async () => {
    const code = lines(
      "export const Card = memo((p: Props) => {",
      "  useEffect(() => {",
      "    if (p.id) { track(p.id); }",
      "  }, [p.id]);",
      "  return <div>{p.id}</div>;",
      "});",
    );
    expect((await flowAt("card.tsx", code, 5)).diagram.nodes[0]?.title).toBe("Card");
    expect((await flowAt("card.tsx", code, 3)).diagram.nodes[0]?.title).toBe("useEffect callback");
  });

  it("an iteration callback reads as part of the enclosing function", async () => {
    const code = lines("function total(xs) {", "  let t = 0;", "  xs.forEach((x) => {", "    t += x;", "  });", "  return t;", "}");
    expect((await flowAt("t.js", code, 4)).diagram.nodes[0]?.title).toBe("total");
  });

  it("Ruby route blocks, PHP closures, Python and Lua lambdas assigned to names", async () => {
    expect((await flowAt("app.rb", lines('get "/orders" do', "  list()", "end"), 2)).diagram.nodes[0]?.title).toBe('get "/orders" callback');
    expect((await flowAt("r.php", lines("<?php", "$h = function ($r) { return listOrders(); };"), 2)).diagram.nodes[0]?.title).toBe("$h");
    expect((await flowAt("h.py", "handler = lambda evt: process(evt)\n", 1)).diagram.nodes[0]?.title).toBe("handler");
    expect((await flowAt("m.lua", lines("local f = function(y)", "  return y", "end"), 2)).diagram.nodes[0]?.title).toBe("f");
  });
});

describe("cursor positions around a function", () => {
  it("a comment or decorator block above the function", async () => {
    const code = lines("/**", " * Places an order.", " * @param x the order", " */", "@Post()", "export async function place(x) {", "  return x;", "}");
    for (const line of [1, 3, 5]) expect((await flowAt("p.ts", code, line)).diagram.nodes[0]?.title).toBe("place");
  });

  it("but not from ordinary code above it", async () => {
    const r = await engine.flow("p.ts", lines("const a = 1;", "function f() {", "  return a;", "}"), { kind: "function", line: 1 }, noCalls);
    expect(r.ok).toBe(false);
  });

  it("Dart: anywhere in a method body, not only the signature line", async () => {
    const code = lines("class A {", "  void run() {", "    if (x > 1) { go(); }", "    done();", "  }", "  int get total { return x; }", "}");
    expect((await flowAt("a.dart", code, 4)).diagram.nodes[0]?.title).toBe("A.run");
    expect((await flowAt("a.dart", code, 6)).diagram.nodes[0]?.title).toBe("A.total");
  });

  it("accessors, initializers and destructors", async () => {
    const cs = lines("class C {", "  public int Total { get { return Compute(); } }", "  ~C() { Close(); }", "}");
    expect((await flowAt("c.cs", cs, 2, 25)).diagram.nodes[0]?.title).toBe("C.Total.get");
    expect((await flowAt("c.cs", cs, 3)).diagram.nodes[0]?.title).toBe("C.~C");
    const kt = lines("class K(val x: Int) {", "  init { setup() }", "  val t: Int", "    get() { return compute() }", "}");
    expect((await flowAt("k.kt", kt, 2)).diagram.nodes[0]?.title).toBe("K.init");
    expect((await flowAt("k.kt", kt, 4)).diagram.nodes[0]?.title).toBe("K.t.get");
    expect((await flowAt("j.java", lines("class J {", "  static { init(); }", "}"), 2)).diagram.nodes[0]?.title).toBe("J.static init");
  });

  it("Lua and Zig functions are found", async () => {
    expect((await flowAt("m.lua", lines("function M.run(x)", "  while x do x = x - 1 end", "end"), 2)).diagram.nodes[0]?.title).toBe("M.run");
    const zig = lines("pub fn add(a: i32, b: i32) i32 {", "    if (a > b) { return a; } else { return b; }", "}");
    const r = await flowAt("m.zig", zig, 2);
    expect(r.diagram.nodes[0]?.title).toBe("add");
    expect(r.diagram.nodes.filter((n) => n.kind === "end")).toHaveLength(2); // both branches of the if/else
  });

  it("Elixir says it is not supported instead of 'no function'", async () => {
    const r = await engine.flow("a.ex", "defmodule A do\n  def f(x), do: x\nend\n", { kind: "function", line: 2 }, noCalls);
    expect(r).toEqual({ ok: false, reason: "Tracer cannot draw Elixir flows yet." });
  });
});

describe("selections that mean a whole function", () => {
  const code = lines("export function top(a: number) {", "  if (a > 1) { return helper(a); }", "  return a;", "}", "class S {", "  place(o: string) {", "    if (!o) { throw new Error('x'); }", "    return o;", "  }", "}");

  it.each([
    [1, 1, "top"],
    [1, 4, "top"],
    [6, 6, "S.place"],
    [6, 9, "S.place"],
  ])("lines %i-%i flow %s, not one card", async (startLine, endLine, title) => {
    const r = await engine.flow("s.ts", code, { kind: "selection", startLine, endLine }, noCalls);
    if (!r.ok) throw new Error(r.reason);
    expect(r.diagram.nodes[0]?.title).toBe(title);
    expect(r.diagram.nodes.some((n) => n.kind === "decision")).toBe(true);
  });
});

describe("flows that used to come out empty or wrong", () => {
  it("a multi-line `return (` shows what is returned, not '('", async () => {
    const code = lines("export function Page() {", "  return (", '    <div className="page">', "      <List />", "    </div>", "  );", "}");
    const end = (await flowAt("page.tsx", code, 2)).diagram.nodes.find((n) => n.kind === "end");
    expect(end?.title).toMatch(/^<div className="page">/);
  });

  it("Python if/elif/elif/else draws every branch", async () => {
    const code = lines("def f(x):", "    if x == 1:", "        a()", "    elif x == 2:", "        b()", "    elif x == 3:", "        c()", "    else:", "        raise ValueError(x)");
    const d = (await flowAt("f.py", code, 2)).diagram;
    expect(d.nodes.filter((n) => n.kind === "decision")).toHaveLength(3);
    expect(titles(d)).toEqual(expect.arrayContaining(["a()", "b()", "c()", "ValueError(x)"]));
  });

  it("a function that does not parse says so", async () => {
    const r = await flowAt("bad.ts", lines("function f(x) {", "  if (x) {", "    go(", "  }", "}"), 2);
    expect(r.warning).toMatch(/does not parse/);
  });
});

describe("calls are recorded in languages whose call node is also an import node", () => {
  it.each([
    ["svc.py", lines("def place(o):", "    check(o)", "    return save(o)", "", "def check(o):", "    pass", "", "def save(o):", "    pass")],
    ["svc.rb", lines("def place(o)", "  check(o)", "  save(o)", "end", "def check(o)", "end", "def save(o)", "end")],
  ])("%s: Trace Calls reaches the callees", async (path, code) => {
    const facts = await engine.facts(path, code);
    expect(facts?.functions.find((f) => f.name === "place")?.calls).toEqual(["check", "save"]);
    const index = buildFunctionIndex([{ path, facts: facts as NonNullable<typeof facts>, service: "" }]);
    const r = callTrace(index, { path, line: 1 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.diagram.nodes.map((n) => n.title).sort()).toEqual(["check", "place", "save"]);
  });

  it("Trace Calls finds the function from a decorator line too", async () => {
    const code = lines("@app.route('/x')", "def handler():", "    return work()", "", "def work():", "    pass");
    expect(await engine.functionAt("h.py", code, 1)).toEqual({ line: 2, name: "handler" });
  });
});

describe("very large files", () => {
  it("a 2,400-function file with a call chain 2,400 deep: overview is capped and lays out without overflowing", async () => {
    const parts = ["class Big {"];
    for (let i = 0; i < 2400; i++) parts.push(`  int f${i}(int n) { return f${i + 1}(n); }`);
    parts.push("}");
    const path = "Big.java";
    const facts = await engine.facts(path, parts.join("\n"));
    if (!facts) throw new Error("no facts");
    const index = buildFunctionIndex([{ path, facts, service: "" }]);
    const o = fileOverview({ path, facts, service: "" }, index);
    if (!o.ok) throw new Error(o.reason);
    expect(o.truncated).toBe(true);
    expect(o.diagram.nodes.length).toBeLessThanOrEqual(62);
    expect(o.diagram.nodes.at(-1)?.title).toBe("2340 more not shown");
  });

  it("a dagre-overflowing chain still gets a layout (grid fallback)", () => {
    const nodes = Array.from({ length: 12000 }, (_, i) => ({ id: `n${i}`, type: "text" as const, x: 0, y: 0, width: 100, height: 40 }));
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, fromNode: `n${i}`, toNode: n.id }));
    expect(() => layoutFlow(nodes, edges)).not.toThrow();
    expect(new Set(nodes.map((n) => `${n.x},${n.y}`)).size).toBe(nodes.length);
  });
});

describe("review follow-ups", () => {
  it("C# auto-properties stay one entity card; only accessors with a body are functions", async () => {
    const code = lines("class Dto {", "  public int Id { get; private set; }", "  public string X { get { return _x.Trim(); } set { _x = value; } }", "}");
    const facts = await engine.facts("Dto.cs", code);
    expect(facts?.functions.map((f) => f.name)).toEqual(["X.get", "X.set"]);
    const bare = await engine.facts("Dto.cs", lines("class Dto {", "  public int Id { get; set; }", "}"));
    expect(bare?.functions).toEqual([]);
  });

  it("Ruby calls without parentheses resolve to their method; require is not a call", async () => {
    const code = lines("class S", "  def place(o)", '    require "json"', "    validate o", "    items.each do |i|", "      save(i)", "    end", "  end", "  def validate(o)", "  end", "  def save(i)", "  end", "end");
    const place = (await engine.facts("s.rb", code))?.functions.find((f) => f.name === "place");
    expect(place?.calls).toEqual(["validate", "items.each", "save"]);
  });

  it("an IIFE is 'anonymous', not ' callback'", async () => {
    const r = await flowAt("i.js", lines("(function () {", "  go();", "})();"), 2);
    expect(r.diagram.nodes[0]?.title).toMatch(/^anonymous \(line 1\)$/);
  });
});

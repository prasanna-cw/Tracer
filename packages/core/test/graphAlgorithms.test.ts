import { describe, expect, it } from "vitest";
import { codeGraphSchema, cycleEdgeKeys, edgeKey, fileImpact, findCycles, isTestFile, localGraph, topFolder } from "../src";

const E = (pairs: string): { source: string; target: string }[] =>
  pairs.split(" ").map((p) => {
    const [source, target] = p.split(">");
    return { source: source!, target: target! };
  });

describe("findCycles (Tarjan)", () => {
  it("finds each strongly connected component with more than one node", () => {
    const edges = E("a>b b>c c>a c>d d>e e>d f>g");
    expect(findCycles(["a", "b", "c", "d", "e", "f", "g"], edges).map((c) => c.join(","))).toEqual(["d,e", "a,b,c"]);
  });

  it("counts self-imports, ignores DAGs and edges to unknown nodes", () => {
    expect(findCycles(["a"], E("a>a"))).toEqual([["a"]]);
    expect(findCycles(["a", "b", "c"], E("a>b b>c a>c"))).toEqual([]);
    expect(findCycles(["a"], E("a>zz"))).toEqual([]);
  });

  it("handles a 5,000-node chain without blowing the stack", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `n${i}`);
    const edges = ids.map((id, i) => ({ source: id, target: ids[(i + 1) % ids.length]! }));
    expect(findCycles(ids, edges)[0]).toHaveLength(5000);
  });

  it("cycleEdgeKeys marks only edges inside a cycle", () => {
    const edges = E("a>b b>a b>c");
    const keys = cycleEdgeKeys(findCycles(["a", "b", "c"], edges), edges);
    expect([...keys].sort()).toEqual([edgeKey(edges[0]!), edgeKey(edges[1]!)].sort());
  });
});

describe("localGraph", () => {
  const edges = E("a>b b>c c>d x>a");
  it.each([
    [0, ["a"]],
    [1, ["a", "b", "x"]],
    [2, ["a", "b", "c", "x"]],
    [3, ["a", "b", "c", "d", "x"]],
  ])("depth %i follows imports both ways", (depth, expected) => {
    expect([...localGraph("a", edges, depth)].sort()).toEqual(expected);
  });
  it("a node with no edges is its own local graph", () => expect([...localGraph("lonely", edges, 3)]).toEqual(["lonely"]));
});

describe("graph helpers", () => {
  it("isTestFile", () => {
    const tests = ["a.test.ts", "src/b.spec.tsx", "src/__tests__/c.ts", "x.test.mjs", "pkg/order_test.go", "app/test_api.py", "app/api_test.py"];
    tests.push("src/test/java/OrderServiceTest.java", "Billing.Tests/InvoiceTests.cs", "spec/models/user_spec.rb", "tests/integration.rs", "lib/a_test.dart");
    expect(tests.filter((t) => !isTestFile(t))).toEqual([]);
    expect(["test.ts", "src/testing/a.ts", "contest.ts", "Contest.java", "Manifest.kt", "src/latest.py", "attestation.go"].some(isTestFile)).toBe(false);
  });
  it("fileImpact walks importers transitively, through cycles, and picks out tests", () => {
    // d imports c, c imports a; b imports a twice-over; cycle a<->x; t is a test reaching a via c
    const edges = E("c>a b>a b>a d>c x>a a>x t.test.ts>c z>q");
    expect(fileImpact("a", edges)).toEqual({ dependents: ["b", "c", "x"], affected: ["b", "c", "d", "t.test.ts", "x"], tests: ["t.test.ts"] });
    expect(fileImpact("d", edges)).toEqual({ dependents: [], affected: [], tests: [] });
  });
  it("topFolder", () => expect([topFolder("src/a/b.ts"), topFolder("main.ts")]).toEqual(["src", "(root)"]));
  it("codeGraphSchema rejects a graph.json that is not ours", () => {
    expect(codeGraphSchema.safeParse({ nodes: [] }).success).toBe(false);
  });
});

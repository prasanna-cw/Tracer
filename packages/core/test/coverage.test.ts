import { describe, expect, it } from "vitest";
import { applyCoverage, parseCobertura, parseCoverage, parseLcov, type CodeGraph } from "../src";

describe("parseLcov", () => {
  it("reads line hits per file and derives covered/total from DA records", () => {
    const text = ["SF:src/a.ts", "DA:1,3", "DA:2,0", "DA:3,1", "end_of_record", "SF:src/b.ts", "DA:1,0", "end_of_record"].join("\n");
    expect(parseLcov(text)).toEqual([
      { path: "src/a.ts", linesCovered: 2, linesTotal: 3 },
      { path: "src/b.ts", linesCovered: 0, linesTotal: 1 },
    ]);
  });

  it("unions duplicate SF blocks for the same file by line number (never double-counts or overwrites)", () => {
    const text = ["SF:src/a.ts", "DA:1,0", "DA:2,1", "end_of_record", "SF:src/a.ts", "DA:1,2", "DA:3,0", "end_of_record"].join("\n");
    expect(parseLcov(text)).toEqual([{ path: "src/a.ts", linesCovered: 2, linesTotal: 3 }]);
  });

  it("ignores a file with no DA records", () => {
    expect(parseLcov("SF:src/empty.ts\nend_of_record\n")).toEqual([]);
  });
});

describe("parseCobertura", () => {
  const xml = (classes: string) => `<?xml version="1.0"?><coverage><packages><package><classes>${classes}</classes></package></packages></coverage>`;

  it("reads line hits per class", () => {
    const text = xml('<class filename="a.py"><lines><line number="1" hits="3"/><line number="2" hits="0"/></lines></class>');
    expect(parseCobertura(text)).toEqual([{ path: "a.py", linesCovered: 1, linesTotal: 2 }]);
  });

  it("unions several classes in the same file by line number", () => {
    const text = xml(
      '<class filename="a.py"><lines><line number="1" hits="1"/></lines></class>' +
        '<class filename="a.py"><lines><line number="2" hits="0"/></lines></class>',
    );
    expect(parseCobertura(text)).toEqual([{ path: "a.py", linesCovered: 1, linesTotal: 2 }]);
  });
});

describe("parseCoverage (format auto-detection)", () => {
  it("picks lcov from an SF: line and Cobertura from an XML header", () => {
    expect(parseCoverage("SF:a.ts\nDA:1,1\nend_of_record\n")).toEqual([{ path: "a.ts", linesCovered: 1, linesTotal: 1 }]);
    expect(parseCoverage('<?xml version="1.0"?><coverage><packages><package><classes><class filename="a.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>')).toEqual([
      { path: "a.ts", linesCovered: 1, linesTotal: 1 },
    ]);
  });

  it("returns nothing for unrecognized content", () => {
    expect(parseCoverage("not a coverage report")).toEqual([]);
  });
});

describe("applyCoverage", () => {
  const graph: CodeGraph = {
    version: 1,
    root: "demo",
    packages: [],
    nodes: [
      { id: "src/a.ts", path: "src/a.ts", folder: "src", ext: "ts", loc: 10, inDegree: 0, outDegree: 0 },
      { id: "src/b.ts", path: "src/b.ts", folder: "src", ext: "ts", loc: 10, inDegree: 0, outDegree: 0 },
    ],
    edges: [],
    summary: { fileCount: 2, skippedCount: 0, edgeCount: 0, unresolvedCount: 0, externalCount: 0, assetCount: 0, cycleCount: 0, unresolved: [], warnings: [] },
  };

  it("attaches coverage on an exact path match, without mutating the input graph", () => {
    const r = applyCoverage(graph, [{ path: "src/a.ts", linesCovered: 8, linesTotal: 10 }]);
    expect(r).toMatchObject({ matched: 1, unmatched: 0 });
    expect(r.graph.nodes[0]).toMatchObject({ coverage: { linesCovered: 8, linesTotal: 10 } });
    expect(graph.nodes[0]?.coverage).toBeUndefined(); // original graph untouched
  });

  it("matches a report path that is an absolute prefix plus the graph's relative path", () => {
    const r = applyCoverage(graph, [{ path: "/home/me/demo/src/a.ts", linesCovered: 5, linesTotal: 10 }]);
    expect(r.matched).toBe(1);
    expect(r.graph.nodes.find((n) => n.path === "src/a.ts")?.coverage).toEqual({ linesCovered: 5, linesTotal: 10 });
  });

  it("leaves an ambiguous suffix match uncovered: a wrong link is worse than no link", () => {
    // "a.ts" alone is a valid suffix match for both src/a.ts and other/a.ts.
    const ambiguous: CodeGraph = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0]!, id: "other/a.ts", path: "other/a.ts" }] };
    const r = applyCoverage(ambiguous, [{ path: "a.ts", linesCovered: 1, linesTotal: 1 }]);
    expect(r.matched).toBe(0);
    expect(r.graph.nodes.some((n) => n.coverage)).toBe(false);
  });

  it("counts a path with no match at all as unmatched", () => {
    const r = applyCoverage(graph, [{ path: "src/ghost.ts", linesCovered: 1, linesTotal: 1 }]);
    expect(r).toMatchObject({ matched: 0, unmatched: 1 });
  });
});

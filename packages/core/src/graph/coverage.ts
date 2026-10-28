import type { CodeGraph, CodeGraphNode } from "./types";

export type FileCoverage = { path: string; linesCovered: number; linesTotal: number };

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * Reads an lcov report (`SF:`, `DA:<line>,<hits>`, `end_of_record`). Lines are unioned by number across
 * every record for a path, so a file covered by more than one `SF:` block (two test runs merged without
 * `lcov -a`, or a monorepo running the same file through two suites) is not double-counted or overwritten.
 */
export function parseLcov(text: string): FileCoverage[] {
  const byPath = new Map<string, Map<number, number>>();
  let lines: Map<number, number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const path = toPosix(line.slice(3).trim());
      lines = byPath.get(path);
      if (!lines) byPath.set(path, (lines = new Map()));
    } else if (line.startsWith("DA:") && lines) {
      const [n, hits] = line.slice(3).split(",").map(Number);
      if (Number.isFinite(n) && Number.isFinite(hits)) lines.set(n as number, Math.max(lines.get(n as number) ?? 0, hits as number));
    } else if (line === "end_of_record") {
      lines = undefined;
    }
  }
  return finish(byPath);
}

/**
 * Reads a Cobertura report. A file with several classes (common in Java/C#/Python) gets one `<class
 * filename="...">` per class; lines are unioned by line number across all of a file's classes, the same
 * reasoning as the lcov reader above.
 */
export function parseCobertura(text: string): FileCoverage[] {
  const byPath = new Map<string, Map<number, number>>();
  for (const cls of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    const path = toPosix(cls[1] as string);
    let lines = byPath.get(path);
    if (!lines) byPath.set(path, (lines = new Map()));
    for (const ln of (cls[2] as string).matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) {
      const n = Number(ln[1]);
      lines.set(n, Math.max(lines.get(n) ?? 0, Number(ln[2])));
    }
  }
  return finish(byPath);
}

function finish(byPath: ReadonlyMap<string, ReadonlyMap<number, number>>): FileCoverage[] {
  return [...byPath].flatMap(([path, lines]) => {
    if (!lines.size) return [];
    const linesCovered = [...lines.values()].filter((h) => h > 0).length;
    return [{ path, linesCovered, linesTotal: lines.size }];
  });
}

/** Detects lcov vs. Cobertura from the content itself (no setup: point Tracer at whatever your test runner wrote). */
export function parseCoverage(text: string): FileCoverage[] {
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("<?xml") || head.startsWith("<coverage")) return parseCobertura(text);
  if (/^(TN|SF):/m.test(text)) return parseLcov(text);
  return [];
}

export type CoverageMergeResult = { graph: CodeGraph; matched: number; unmatched: number };

/**
 * Attaches coverage to the graph's nodes by path. An exact match wins; otherwise a report path that is some
 * absolute prefix plus the graph's relative path (or vice versa) matches if, and only if, exactly one node
 * fits — ambiguous paths are left uncovered rather than guessed (the same rule the import linker uses: a
 * wrong link is worse than no link). Returns a new graph; `graph` itself is not mutated.
 */
export function applyCoverage(graph: CodeGraph, files: readonly FileCoverage[]): CoverageMergeResult {
  const nodes: CodeGraphNode[] = graph.nodes.map((n) => ({ ...n }));
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  let matched = 0;
  for (const f of files) {
    let node = byPath.get(f.path);
    if (!node) {
      const candidates = nodes.filter((n) => f.path.endsWith(`/${n.path}`) || n.path.endsWith(`/${f.path}`));
      node = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (node) {
      node.coverage = { linesCovered: f.linesCovered, linesTotal: f.linesTotal };
      matched++;
    }
  }
  return { graph: { ...graph, nodes }, matched, unmatched: files.length - matched };
}

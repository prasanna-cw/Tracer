import type { CodeGraphEdge } from "./types";

/**
 * Tarjan's strongly connected components, iterative (no recursion limit on deep import chains).
 * Returns only components that form a cycle: more than one node, or a node importing itself.
 */
export function findCycles(nodeIds: readonly string[], edges: readonly CodeGraphEdge[]): string[][] {
  const out = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const selfLoops = new Set<string>();
  for (const e of edges) {
    out.get(e.source)?.push(e.target);
    if (e.source === e.target) selfLoops.add(e.source);
  }

  type Frame = { id: string; index: number; low: number; next: number; neighbors: string[] };
  let counter = 0;
  const indexOf = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const enter = (id: string): Frame => {
    indexOf.set(id, counter);
    stack.push(id);
    onStack.add(id);
    const i = counter++;
    return { id, index: i, low: i, next: 0, neighbors: out.get(id) ?? [] };
  };

  for (const start of nodeIds) {
    if (indexOf.has(start)) continue;
    const work: Frame[] = [enter(start)]; // explicit call stack
    for (let frame = work.at(-1); frame; frame = work.at(-1)) {
      const w = frame.neighbors[frame.next++];
      if (w !== undefined) {
        const wIndex = indexOf.get(w);
        if (wIndex === undefined) {
          if (out.has(w)) work.push(enter(w)); // else: edge to a node outside the set
        } else if (onStack.has(w)) {
          frame.low = Math.min(frame.low, wIndex);
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) parent.low = Math.min(parent.low, frame.low);
      if (frame.low === frame.index) {
        const component: string[] = [];
        for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
          onStack.delete(v);
          component.push(v);
          if (v === frame.id) break;
        }
        if (component.length > 1 || selfLoops.has(frame.id)) cycles.push(component.sort());
      }
    }
  }
  return cycles;
}

/** Edges whose two ends are in the same cycle: the ones a "highlight cycles" view should color. */
export function cycleEdgeKeys(cycles: readonly string[][], edges: readonly CodeGraphEdge[]): Set<string> {
  const componentOf = new Map<string, number>();
  cycles.forEach((c, i) => c.forEach((id) => componentOf.set(id, i)));
  const keys = new Set<string>();
  for (const e of edges) {
    const c = componentOf.get(e.source);
    if (c !== undefined && c === componentOf.get(e.target)) keys.add(edgeKey(e));
  }
  return keys;
}

export const edgeKey = (e: CodeGraphEdge): string => `${e.source}\u0000${e.target}`;

/** Nodes within `depth` hops of `start`, following imports in both directions (Obsidian's local graph). */
export function localGraph(start: string, edges: readonly CodeGraphEdge[], depth: number): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

/** First path segment, or "(root)" for files at the top level; drives the per-folder colors and filters. */
export const topFolder = (path: string): string => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "(root)");

import dagre from "@dagrejs/dagre";
import type { DiagramEdge, DiagramNode } from "../schema/diagram";

export type LayoutOptions = {
  direction?: "TB" | "LR";
  /** Space between nodes of one rank / between ranks. */
  nodeGap?: number;
  rankGap?: number;
};

const LABEL_W = 56;
const LABEL_H = 18;

/**
 * Lays nodes out in layers (dagre): the call/flow direction runs top to bottom, nodes of one step sit side by
 * side, cycles are broken automatically, and long edges get reserved space so they route around cards instead
 * of through them. Mutates x/y of `nodes` (width/height must already be set) and returns the bounding box.
 */
export function layoutFlow(nodes: DiagramNode[], edges: readonly DiagramEdge[], opts: LayoutOptions = {}): { width: number; height: number } {
  if (!nodes.length) return { width: 0, height: 0 };
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: opts.direction ?? "TB", nodesep: opts.nodeGap ?? 48, ranksep: opts.rankGap ?? 64, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (!ids.has(e.fromNode) || !ids.has(e.toNode) || e.fromNode === e.toNode) continue;
    g.setEdge(e.fromNode, e.toNode, e.label ? { width: LABEL_W, height: LABEL_H, labelpos: "c" } : {}, e.id);
  }
  dagre.layout(g);
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) {
    const p = g.node(n.id);
    n.x = Math.round(p.x - n.width / 2);
    n.y = Math.round(p.y - n.height / 2);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { width: maxX, height: maxY };
}

import type { Edge, Node } from "@xyflow/react";
import { CATEGORIES, chooseSides, hashText, resolveCategory, type Diagram, type DiagramEdge, type DiagramNode } from "@tracer/core";

export type FlowNode = Node<DiagramNode>;
export type EdgeState = "active" | "dim" | undefined;
export type FlowEdgeData = { edge: DiagramEdge; state: EdgeState };
export type FlowEdge = Edge<FlowEdgeData>;
export type Highlight = { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> } | null;

export const FAMILIES = CATEGORIES;
export type Family = (typeof CATEGORIES)[number] | "plain";

// Same mapping as the JSON Canvas export, so Obsidian presets look like our categories.
const PRESET_FAMILY: Record<string, Family> = { "1": "warning", "2": "entity", "3": "data", "4": "service", "5": "db", "6": "layer" };

/** Explicit color wins over category. Unknown categories get a stable family by hash, so they stay themed. */
export function paletteOf(n: Pick<DiagramNode, "color" | "category">): { family: Family; hex?: string } {
  if (n.color?.startsWith("#")) return { family: "plain", hex: n.color };
  if (n.color && PRESET_FAMILY[n.color]) return { family: PRESET_FAMILY[n.color] as Family };
  if (!n.category) return { family: "plain" };
  const known = resolveCategory(n.category); // canonical name or alias
  if (known) return { family: known };
  return { family: FAMILIES[parseInt(hashText(n.category), 16) % FAMILIES.length] as Family };
}

export function nodeTypeOf(n: DiagramNode): string {
  if (n.type === "group") return "cmgroup"; // not "group": React Flow styles that type itself
  if (n.type === "file" || n.type === "link") return n.type;
  return n.kind ?? "text";
}

const nodeState = (id: string, h: Highlight): string | undefined => (h ? (h.nodeIds.has(id) ? "cm-active" : "cm-dim") : undefined);

/**
 * Builds React Flow nodes, reusing the previous object whenever nothing about it changed so React
 * Flow (and the memoized node components) skip it. Keeps RF-owned fields (selection, measurements).
 */
export function mergeFlowNodes(prev: readonly FlowNode[], d: Diagram, h: Highlight): FlowNode[] {
  const byId = new Map(prev.map((n) => [n.id, n]));
  return d.nodes.map((n) => {
    const p = byId.get(n.id);
    const className = nodeState(n.id, h);
    if (p && p.data === n && p.className === className && !p.dragging) return p;
    return {
      ...p,
      id: n.id,
      type: nodeTypeOf(n),
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      data: n,
      className,
      zIndex: n.type === "group" ? -1 : 0,
      ariaLabel: n.title ?? n.label ?? n.text?.slice(0, 80) ?? n.id,
    };
  });
}

export function toFlowEdges(d: Diagram, h: Highlight): FlowEdge[] {
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  return d.edges.flatMap((e): FlowEdge[] => {
    const from = nodes.get(e.fromNode);
    const to = nodes.get(e.toNode);
    if (!from || !to) return []; // schema forbids this; never crash the canvas over it
    const { fromSide, toSide } = chooseSides(from, to, e);
    const state: EdgeState = h ? (h.edgeIds.has(e.id) ? "active" : "dim") : undefined;
    return [
      {
        id: e.id,
        type: "diagram",
        source: e.fromNode,
        target: e.toNode,
        sourceHandle: `s-${fromSide}`,
        targetHandle: `t-${toSide}`,
        data: { edge: e, state },
        zIndex: state === "active" ? 1 : 0,
      },
    ];
  });
}

/** Plain text of a node, for tooltips on truncated content and for the side panel. */
export function plainText(n: DiagramNode): string {
  return [n.title, n.subtitle, n.label, n.text, ...(n.rows ?? []).map((r) => r.text)].filter(Boolean).join("\n");
}

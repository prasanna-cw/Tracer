import type { DiagramNode } from "../schema/diagram";

/**
 * Nodes inside a group (fully contained rect), as in JSON Canvas/Obsidian where membership is geometric.
 * Nested groups and their contents are included, so moving the outer group moves everything in it.
 */
export function groupMembers(nodes: readonly DiagramNode[], groupId: string): DiagramNode[] {
  const g = nodes.find((n) => n.id === groupId);
  if (!g || g.type !== "group") return [];
  return nodes.filter(
    (n) =>
      n.id !== g.id && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height,
  );
}

/** Moves for dragging a group to (x, y): the group plus every member, shifted by the same delta. */
export function moveGroup(
  nodes: readonly DiagramNode[],
  groupId: string,
  x: number,
  y: number,
): { id: string; x: number; y: number }[] {
  const g = nodes.find((n) => n.id === groupId);
  if (!g) return [];
  const dx = x - g.x;
  const dy = y - g.y;
  return [{ id: g.id, x, y }, ...groupMembers(nodes, groupId).map((n) => ({ id: n.id, x: n.x + dx, y: n.y + dy }))];
}

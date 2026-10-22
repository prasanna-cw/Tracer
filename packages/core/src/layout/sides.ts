import type { Side } from "../schema/diagram";

export type Rect = { x: number; y: number; width: number; height: number };

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/**
 * Picks connection sides for an edge from relative node positions, so an LLM or a hand-written
 * diagram can omit `fromSide`/`toSide`. Boxes stacked vertically (overlapping x-ranges) connect
 * bottom->top; side by side, right->left; diagonal, along the larger distance between centers.
 * Explicit sides win.
 */
export function chooseSides(
  from: Rect,
  to: Rect,
  explicit: { fromSide?: Side; toSide?: Side } = {},
): { fromSide: Side; toSide: Side } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const ox = overlaps(from.x, from.x + from.width, to.x, to.x + to.width);
  const oy = overlaps(from.y, from.y + from.height, to.y, to.y + to.height);
  const vertical = ox !== oy ? ox : Math.abs(dy) >= Math.abs(dx);
  const auto: { fromSide: Side; toSide: Side } = vertical
    ? dy >= 0
      ? { fromSide: "bottom", toSide: "top" }
      : { fromSide: "top", toSide: "bottom" }
    : dx >= 0
      ? { fromSide: "right", toSide: "left" }
      : { fromSide: "left", toSide: "right" };
  return { fromSide: explicit.fromSide ?? auto.fromSide, toSide: explicit.toSide ?? auto.toSide };
}

import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { ZoomTransform } from "d3-zoom";
import type { CodeGraphNode } from "@codemap/core";

/** `colorIndex` is the folder's palette slot; `color` is resolved from the theme just before each frame. */
export type SimNode = SimulationNodeDatum & { id: string; node: CodeGraphNode; r: number; colorIndex: number; color: string; label: string };
export type SimLink = SimulationLinkDatum<SimNode> & { key: string };

export type GraphColors = { bg: string; edge: string; accent: string; cycle: string; text: string; palette: string[] };

export type Scene = {
  nodes: readonly SimNode[];
  links: readonly SimLink[];
  colors: GraphColors;
  /** Hovered (or else selected) node: it and its neighbors stay bright, the rest dims. */
  focus: { id: string; neighbors: ReadonlySet<string> } | null;
  selectedId: string | null;
  matches: ReadonlySet<string>;
  cycleKeys: ReadonlySet<string> | null; // null = cycle highlighting off
  labelZoom: number;
};

const DIM = 0.15;
const TAU = Math.PI * 2;

/** One full frame. Batches every edge style into one path and every node color into one path. */
export function drawGraph(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number, t: ZoomTransform, s: Scene): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = s.colors.bg;
  ctx.fillRect(0, 0, width, height);

  const lit = (id: string): boolean =>
    s.focus ? id === s.focus.id || s.focus.neighbors.has(id) : s.matches.size ? s.matches.has(id) : true;
  const dimming = s.focus !== null || s.matches.size > 0;

  // Graph space.
  ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
  const px = 1 / t.k; // one screen pixel in graph units

  const plain: SimLink[] = [];
  const cycle: SimLink[] = [];
  const focused: SimLink[] = [];
  for (const l of s.links) {
    const a = l.source as SimNode;
    const b = l.target as SimNode;
    if (s.focus && (a.id === s.focus.id || b.id === s.focus.id)) focused.push(l);
    else if (s.cycleKeys?.has(l.key)) cycle.push(l);
    else plain.push(l);
  }
  strokeLinks(ctx, plain, s.colors.edge, px, dimming ? DIM * 2 : 1);
  strokeLinks(ctx, cycle, s.colors.cycle, 1.8 * px, s.focus ? 0.5 : 1);
  strokeLinks(ctx, focused, s.colors.accent, 1.6 * px, 1);

  // Arrowheads only when zoomed in enough to read direction, and only near the viewport.
  if (t.k >= 1.2) {
    const view = viewport(t, width, height, 40);
    drawArrows(ctx, plain, s.colors.edge, px, view, dimming ? DIM * 2 : 1);
    drawArrows(ctx, cycle, s.colors.cycle, px, view, 1);
    drawArrows(ctx, focused, s.colors.accent, px, view, 1);
  }

  // Nodes, bucketed by color and brightness.
  const buckets = new Map<string, SimNode[]>();
  for (const n of s.nodes) {
    const key = `${n.color}|${lit(n.id) ? 1 : 0}`;
    const list = buckets.get(key);
    if (list) list.push(n);
    else buckets.set(key, [n]);
  }
  for (const [key, list] of buckets) {
    const [color, on] = key.split("|");
    ctx.globalAlpha = on === "1" ? 1 : DIM;
    ctx.fillStyle = color ?? s.colors.text;
    ctx.beginPath();
    for (const n of list) {
      ctx.moveTo((n.x ?? 0) + n.r, n.y ?? 0);
      ctx.arc(n.x ?? 0, n.y ?? 0, n.r, 0, TAU);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const ring = (id: string | null | undefined, color: string) => {
    const n = id ? s.nodes.find((x) => x.id === id) : undefined;
    if (!n) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, n.r + 3 * px, 0, TAU);
    ctx.stroke();
  };
  ring(s.selectedId, s.colors.accent);
  if (s.focus && s.focus.id !== s.selectedId) ring(s.focus.id, s.colors.text);

  // Labels in screen space so text stays crisp and constant-size.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = s.colors.text;
  const all = t.k >= s.labelZoom;
  for (const n of s.nodes) {
    const special = n.id === s.selectedId || (s.focus !== null && lit(n.id)) || s.matches.has(n.id);
    if (!all && !special) continue;
    const sx = t.applyX(n.x ?? 0);
    const sy = t.applyY(n.y ?? 0) + n.r * t.k + 3;
    if (sx < -100 || sx > width + 100 || sy < -20 || sy > height + 20) continue;
    ctx.globalAlpha = lit(n.id) ? 1 : DIM * 2;
    ctx.fillText(n.label, sx, sy);
  }
  ctx.globalAlpha = 1;
}

function strokeLinks(ctx: CanvasRenderingContext2D, links: SimLink[], color: string, width: number, alpha: number): void {
  if (!links.length) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const l of links) {
    const a = l.source as SimNode;
    const b = l.target as SimNode;
    ctx.moveTo(a.x ?? 0, a.y ?? 0);
    ctx.lineTo(b.x ?? 0, b.y ?? 0);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const viewport = (t: ZoomTransform, w: number, h: number, pad: number): Box => ({
  x0: t.invertX(-pad),
  y0: t.invertY(-pad),
  x1: t.invertX(w + pad),
  y1: t.invertY(h + pad),
});

function drawArrows(ctx: CanvasRenderingContext2D, links: SimLink[], color: string, px: number, v: Box, alpha: number): void {
  const size = 5 * px;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const l of links) {
    const a = l.source as SimNode;
    const b = l.target as SimNode;
    const bx = b.x ?? 0;
    const by = b.y ?? 0;
    if (bx < v.x0 || bx > v.x1 || by < v.y0 || by > v.y1) continue;
    const dx = bx - (a.x ?? 0);
    const dy = by - (a.y ?? 0);
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tipX = bx - ux * (b.r + px);
    const tipY = by - uy * (b.r + px);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size - uy * size * 0.6, tipY - uy * size + ux * size * 0.6);
    ctx.lineTo(tipX - ux * size + uy * size * 0.6, tipY - uy * size - ux * size * 0.6);
    ctx.closePath();
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { ZoomTransform } from "d3-zoom";
import type { CodeGraphNode } from "@tracer/core";

/** `colorIndex` is the folder's palette slot; `color` is resolved from the theme just before each frame. */
/** `x`/`y`: where the node is drawn; `tx`/`ty`: where the layout last put it (drawing eases toward it). */
export type SimNode = SimulationNodeDatum & { id: string; node: CodeGraphNode; r: number; colorIndex: number; color: string; label: string; tx?: number; ty?: number };
export type SimLink = SimulationLinkDatum<SimNode> & { key: string };

export type GraphColors = { bg: string; edge: string; accent: string; cycle: string; text: string; palette: string[] };

export type Scene = {
  nodes: readonly SimNode[];
  links: readonly SimLink[];
  colors: GraphColors;
  /** Hovered (or else selected) node: it and its neighbors stay bright, the rest dims. */
  focus: { id: string; neighbors: ReadonlySet<string> } | null;
  /** 0..1: how far the focus highlight has faded in (it fades rather than switching). */
  fade: number;
  selectedId: string | null;
  matches: ReadonlySet<string>;
  cycleKeys: ReadonlySet<string> | null; // null = cycle highlighting off
  labelZoom: number;
  /** The most connected files: labelled at every zoom so the overview names what matters. */
  hubs: ReadonlySet<string>;
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
  const amount = s.focus ? s.fade : s.matches.size ? 1 : 0; // how dimmed the unlit part is, 0..1
  const mix = (dim: number): number => 1 - (1 - dim) * amount; // alpha of an unlit item

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
  strokeLinks(ctx, plain, s.colors.edge, px, mix(DIM * 2));
  strokeLinks(ctx, cycle, s.colors.cycle, 1.8 * px, s.focus ? 1 - 0.5 * s.fade : 1);
  // Focused edges cross-fade from plain to accent.
  strokeLinks(ctx, focused, s.colors.edge, px, 1 - s.fade);
  strokeLinks(ctx, focused, s.colors.accent, 1.6 * px, s.fade);

  // Arrowheads only when zoomed in enough to read direction, and only near the viewport.
  if (t.k >= 1.2) {
    const view = viewport(t, width, height, 40);
    drawArrows(ctx, plain, s.colors.edge, px, view, mix(DIM * 2));
    drawArrows(ctx, cycle, s.colors.cycle, px, view, 1);
    drawArrows(ctx, focused, s.colors.accent, px, view, s.fade);
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
    ctx.globalAlpha = on === "1" ? 1 : mix(DIM);
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
  ctx.strokeStyle = s.colors.bg;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  const all = t.k >= s.labelZoom;
  // Important labels (selected, found, highlighted, hubs) are placed first; any later label that would
  // overlap one already drawn is skipped until you zoom in, so text never piles up.
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const shown: { n: SimNode; sx: number; sy: number; rank: number }[] = [];
  for (const n of s.nodes) {
    const rank = n.id === s.selectedId ? 0 : s.matches.has(n.id) ? 1 : s.focus !== null && lit(n.id) ? 2 : !s.focus && s.hubs.has(n.id) ? 3 : 4;
    if (!all && rank === 4) continue;
    const sx = t.applyX(n.x ?? 0);
    const sy = t.applyY(n.y ?? 0) + n.r * t.k + 3;
    if (sx < -100 || sx > width + 100 || sy < -20 || sy > height + 20) continue;
    shown.push({ n, sx, sy, rank });
  }
  shown.sort((a, b) => a.rank - b.rank);
  for (const { n, sx, sy } of shown) {
    const half = ctx.measureText(n.label).width / 2 + 2;
    const box = { x0: sx - half, x1: sx + half, y0: sy - 1, y1: sy + 13 };
    if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
    placed.push(box);
    ctx.globalAlpha = lit(n.id) ? 1 : mix(DIM * 2);
    ctx.strokeText(n.label, sx, sy); // halo in the background color keeps labels readable over edges
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

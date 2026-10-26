import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type ForceManyBody,
  type ForceX,
  type ForceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

/**
 * The force layout, DOM-free so it runs in a Web Worker (and in unit tests). At 2,000 files / 6,000 imports
 * one d3 tick costs ~25 ms; on the main thread that alone capped the view at ~20 fps. In a worker, the main
 * thread only draws and stays at 60 fps; the layout just settles at whatever pace the worker sustains.
 */

export type LayoutSettings = { center: number; repel: number; linkStrength: number; linkDistance: number };
export type LayoutNode = { id: string; r: number; x?: number; y?: number };

export type ToLayout =
  | { type: "graph"; gen: number; nodes: LayoutNode[]; links: [number, number][]; settings: LayoutSettings; reduceMotion: boolean }
  | { type: "drag"; index: number; x: number; y: number }
  | { type: "release"; index: number };

/** Positions as [x0, y0, x1, y1, ...] in the order of the last "graph" message. */
export type FromLayout = { type: "positions"; gen: number; positions: Float32Array; settled: boolean };

type N = SimulationNodeDatum & { r: number };
type L = SimulationLinkDatum<N>;

const WARM_MS = 600; // off-screen layout before the first frame of new files (at most)
const WARM_ALPHA = 0.08; // ...or until the layout is this calm
const COLLIDE_LIMIT = 1000; // collision costs ~25% of a tick; above this many nodes the layout reads fine without it

export function createLayout(
  post: (message: FromLayout, transfer: Transferable[]) => void,
  schedule: (fn: () => void) => void,
  now: () => number = () => performance.now(),
) {
  const sim = forceSimulation<N, L>([])
    .force("link", forceLink<N, L>([]))
    .force("charge", forceManyBody<N>().theta(0.9).distanceMax(1000))
    .force("x", forceX<N>(0))
    .force("y", forceY<N>(0))
    // One tick per frame and a slow cool-down: nodes glide into place over ~4 s instead of jumping there
    // (several ticks per frame looked fast but jerky). Lower friction keeps a little drift, like Obsidian.
    .alphaDecay(0.028)
    .velocityDecay(0.32)
    .stop();
  let running = false;
  let dragging = 0;
  let gen = 0; // echoes the last "graph" message so the main thread can drop stale frames

  const emit = (settled: boolean) => {
    const nodes = sim.nodes();
    const positions = new Float32Array(nodes.length * 2);
    nodes.forEach((n, i) => {
      positions[2 * i] = n.x ?? 0;
      positions[2 * i + 1] = n.y ?? 0;
    });
    post({ type: "positions", gen, positions, settled }, [positions.buffer]);
  };
  const settledNow = () => dragging === 0 && sim.alpha() < sim.alphaMin();

  const loop = () => {
    if (!running) return;
    sim.tick();
    const settled = settledNow();
    emit(settled);
    if (settled) running = false;
    else schedule(loop);
  };
  const run = () => {
    if (!running) {
      running = true;
      schedule(loop);
    }
  };

  return {
    handle(m: ToLayout): void {
      if (m.type === "graph") {
        gen = m.gen;
        const nodes: N[] = m.nodes.map((n) => ({ r: n.r, x: n.x, y: n.y }));
        sim.nodes(nodes);
        (sim.force("link") as ForceLink<N, L>)
          .links(m.links.map(([s, t]) => ({ source: s, target: t })))
          .distance(m.settings.linkDistance)
          .strength(m.settings.linkStrength);
        (sim.force("charge") as ForceManyBody<N>).strength(-m.settings.repel);
        (sim.force("x") as ForceX<N>).strength(m.settings.center);
        (sim.force("y") as ForceY<N>).strength(m.settings.center);
        sim.force("collide", nodes.length <= COLLIDE_LIMIT ? forceCollide<N>((d) => d.r + 1.5) : null);
        dragging = 0;
        if (m.reduceMotion) {
          // No animation: settle in one go and post a single frame.
          running = false;
          sim.alpha(1).alphaTarget(0);
          while (!settledNow()) sim.tick();
          emit(true);
          return;
        }
        sim.alpha(Math.max(sim.alpha(), 0.5));
        // New files without positions: lay out off-screen first, so the first frame the user sees is close
        // to final instead of an explosion from the center. Then the rest settles in animated frames.
        if (m.nodes.some((n) => n.x === undefined)) {
          sim.alpha(1);
          const start = now();
          while (sim.alpha() > WARM_ALPHA && now() - start < WARM_MS) sim.tick();
        }
        run();
      } else if (m.type === "drag") {
        const n = sim.nodes()[m.index];
        if (!n) return;
        if (n.fx == null) dragging++;
        n.fx = m.x; // pinned while dragging
        n.fy = m.y;
        sim.alphaTarget(0.3);
        run();
      } else {
        const n = sim.nodes()[m.index];
        if (!n || n.fx == null) return;
        n.fx = null; // released on drop, like Obsidian
        n.fy = null;
        dragging = Math.max(0, dragging - 1);
        if (!dragging) sim.alphaTarget(0);
        run();
      }
    },
  };
}

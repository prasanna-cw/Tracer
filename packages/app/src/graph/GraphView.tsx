import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { drag } from "d3-drag";
import { quadtree, type Quadtree } from "d3-quadtree";
import { pointer, select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { cycleEdgeKeys, edgeKey, fileImpact, findCycles, type CodeGraph } from "@tracer/core";
import type { HostAdapter } from "../host/HostAdapter";
import { Icon, IconButton } from "../ui/Icon";
import { groupResolver, neighborsOf, searchMatches, visibleNodeIds } from "./graphModel";
import type { FromLayout, ToLayout } from "./layoutEngine";
// Inlined as a blob: worker. A webview cannot start a Worker from its (cross-origin) resource URL.
import LayoutWorker from "./layout.worker?worker&inline";
import { drawGraph, type GraphColors, type Scene, type SimLink, type SimNode } from "./renderer";

type Settings = { center: number; repel: number; linkStrength: number; linkDistance: number; nodeSize: number; labelZoom: number };
const DEFAULTS: Settings = { center: 0.06, repel: 140, linkStrength: 0.5, linkDistance: 50, nodeSize: 1, labelZoom: 1.1 };
const PALETTE_SIZE = 6;
const HUB_LABELS = 12; // always-labelled most-connected files

/** Main-thread side of the layout: what is drawn and hit-tested. The physics runs in layout.worker.ts. */
type Engine = {
  worker: Worker;
  gen: number;
  byId: Map<string, SimNode>;
  nodes: SimNode[]; // visible, in the order of the worker's position arrays
  index: Map<string, number>;
  links: SimLink[];
  tree: Quadtree<SimNode> | null;
  maxR: number;
  fitted: boolean;
  placed: boolean; // positions for the current node set have arrived (before that, nothing is drawn)
};

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function readColors(): GraphColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v("--bg"),
    edge: v("--graph-edge"),
    accent: v("--accent"),
    cycle: v("--graph-cycle"),
    text: v("--text"),
    palette: Array.from({ length: PALETTE_SIZE }, (_, i) => v(`--graph-${i + 1}`)),
  };
}

/** Loads the graph through the host, then hands it to the explorer. */
export function GraphView({ host, theme }: { host: HostAdapter; theme: string }) {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    host.loadGraph().then(
      (g) => !cancelled && setGraph(g),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    // A source file changed on disk and the host re-analyzed: show the new graph without the user reopening the view.
    const unsubscribe = host.onGraphChanged?.((g) => !cancelled && setGraph(g));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [host]);
  const openSource = useCallback((path: string) => void host.openSource(path), [host]);

  if (error) {
    return (
      <div className="empty" role="alert">
        <h2>Could not load the graph</h2>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!graph) return <div className="empty">Loading graph…</div>;
  if (!graph.nodes.length) return <div className="empty">This graph has no files. Check the --root you analyzed.</div>;
  return <GraphExplorer graph={graph} theme={theme} onOpenSource={openSource} />;
}

function GraphExplorer({ graph, theme, onOpenSource }: { graph: CodeGraph; theme: string; onOpenSource: (path: string) => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [hideTests, setHideTests] = useState(false);
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<string>>(new Set());
  const [localDepth, setLocalDepth] = useState(0); // 0 = off
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCycles, setShowCycles] = useState(false);

  // ---- derived data ---------------------------------------------------------------------------
  // A repo with package.json files below its root is a monorepo: color by package (two levels).
  const groupOf = useMemo(() => groupResolver(graph.nodes.map((n) => n.path), graph.packages.length > 0), [graph]);
  // Natural order for the legend (pkg2 before pkg10); display only, nothing persisted depends on it.
  const groups = useMemo(
    () => [...new Set(graph.nodes.map((n) => groupOf(n.path)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [graph, groupOf],
  );
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of graph.nodes) m.set(groupOf(n.path), (m.get(groupOf(n.path)) ?? 0) + 1);
    return m;
  }, [graph, groupOf]);
  const groupIndex = useMemo(() => new Map(groups.map((g, i) => [g, i % PALETTE_SIZE])), [groups]);
  const cycles = useMemo(() => findCycles(graph.nodes.map((n) => n.id), graph.edges), [graph]);
  const cycleKeys = useMemo(() => cycleEdgeKeys(cycles, graph.edges), [cycles, graph]);
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set()]));
    for (const e of graph.edges) {
      m.get(e.source)?.add(e.target);
      m.get(e.target)?.add(e.source);
    }
    return m;
  }, [graph]);
  const localId = localDepth > 0 ? selectedId : null;
  const visible = useMemo(
    () =>
      visibleNodeIds(
        graph,
        { hideOrphans, hideTests, hiddenGroups, local: localId ? { id: localId, depth: localDepth } : null },
        groupOf,
      ),
    [graph, hideOrphans, hideTests, hiddenGroups, localId, localDepth, groupOf],
  );
  const matchList = useMemo(() => searchMatches(graph.nodes, query), [graph, query]);
  const matches = useMemo(() => new Set(matchList.filter((id) => visible.has(id))), [matchList, visible]);
  const visibleEdges = useMemo(() => graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target)), [graph, visible]);
  const hubs = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of visibleEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const top = [...degree].sort((a, b) => b[1] - a[1]).slice(0, HUB_LABELS);
    return new Set(top.filter(([, d]) => d >= 3).map(([id]) => id));
  }, [visibleEdges]);

  // ---- imperative engine (refs: never re-render React per frame) ------------------------------------
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  // Positions from the graph just torn down, so a live refresh (D36) continues the layout instead of
  // restarting it: only genuinely new files (not in here) get the worker's off-screen warm-up treatment.
  const lastPositions = useRef(new Map<string, { x: number; y: number }>());
  const transform = useRef<ZoomTransform>(zoomIdentity);
  const zoomBehavior = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const hover = useRef<string | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const scene = useRef<Omit<Scene, "nodes" | "links" | "colors" | "focus" | "fade"> & { adjacency: Map<string, Set<string>> }>({
    selectedId: null,
    matches: new Set(),
    cycleKeys: null,
    labelZoom: DEFAULTS.labelZoom,
    hubs: new Set(),
    adjacency: new Map(),
  });
  const colors = useRef<{ theme: string | undefined; value: GraphColors } | null>(null);
  const frame = useRef(0);
  const drawRef = useRef<() => void>(() => undefined);
  const shownSet = useRef<ReadonlySet<string> | null>(null);

  const fade = useRef({ value: 0, last: null as { id: string; neighbors: ReadonlySet<string> } | null });

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const e = engine.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !e || !ctx) return;
    // Theme colors are read lazily: the theme attribute is set by App's effect, which runs after ours.
    const theme = document.documentElement.dataset.theme;
    const cached = colors.current;
    const themeColors = cached && cached.theme === theme ? cached.value : readColors();
    colors.current = { theme, value: themeColors };
    const s = scene.current;
    const focusId = hover.current ?? s.selectedId;
    const nodes = e.placed ? e.nodes : []; // no pile of dots at the origin before the first layout frame
    // Nodes glide to where the layout put them instead of jumping there; the highlight fades in and out.
    const ease = reducedMotion() ? 1 : 0.22;
    let moving = false;
    for (const n of nodes) {
      n.color = themeColors.palette[n.colorIndex] ?? themeColors.text;
      if (n.tx === undefined || n.ty === undefined || n.x === undefined || n.y === undefined) continue;
      const dx = n.tx - n.x;
      const dy = n.ty - n.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) {
        n.x += dx * ease;
        n.y += dy * ease;
        moving = true;
      } else {
        n.x = n.tx;
        n.y = n.ty;
      }
    }
    if (moving) e.tree = null;
    const f = fade.current;
    const target = focusId ? 1 : 0;
    if (focusId) f.last = { id: focusId, neighbors: s.adjacency.get(focusId) ?? new Set() };
    const step = reducedMotion() ? 1 : 0.18;
    f.value = Math.abs(target - f.value) < 0.02 ? target : f.value + (target - f.value) * step;
    const focus = focusId ? f.last : f.value > 0 ? f.last : null; // the last focus stays while it fades out
    drawGraph(ctx, size.current.w, size.current.h, size.current.dpr, transform.current, {
      ...s,
      nodes,
      links: e.placed ? e.links : [],
      colors: themeColors,
      focus,
      fade: focus ? f.value : 1,
    });
    if ((moving || f.value !== target) && !frame.current) frame.current = requestAnimationFrame(() => drawRef.current()); // keep animating
  }, []);
  const requestDraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(() => drawRef.current());
  }, []);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  const fit = useCallback(() => {
    const e = engine.current;
    const canvas = canvasRef.current;
    const z = zoomBehavior.current;
    const nodes = e?.nodes ?? [];
    if (!canvas || !z || !nodes.length) return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const { w, h } = size.current;
    // The controls float over the left edge on wide screens: fit into the area to their right.
    const panel = canvas.parentElement?.parentElement?.querySelector<HTMLElement>(".graph-controls");
    const inset = panel && w > 720 ? panel.offsetWidth + 24 : 0;
    const k = Math.min(2, 0.9 / Math.max((x1 - x0 + 40) / (w - inset), (y1 - y0 + 40) / h));
    const t = zoomIdentity.translate(inset + (w - inset) / 2, h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    select(canvas).call(z.transform, t);
  }, []);

  // Layout worker: one per graph. Positions live on the SimNode objects and survive filter changes.
  useEffect(() => {
    // Label = file name, or parent/name when several files share the name (three index.ts are common).
    const counts = new Map<string, number>();
    for (const n of graph.nodes) counts.set(basename(n.path), (counts.get(basename(n.path)) ?? 0) + 1);
    const label = (p: string) => ((counts.get(basename(p)) ?? 0) > 1 ? p.split("/").slice(-2).join("/") : basename(p));
    const byId = new Map<string, SimNode>(
      graph.nodes.map((n) => {
        const sim: SimNode = { id: n.id, node: n, r: 4, colorIndex: 0, color: "", label: label(n.path) };
        const prior = lastPositions.current.get(n.id);
        if (prior) {
          sim.x = prior.x;
          sim.y = prior.y;
        }
        return [n.id, sim];
      }),
    );
    const worker = new LayoutWorker();
    const e: Engine = { worker, gen: 0, byId, nodes: [], index: new Map(), links: [], tree: null, maxR: 0, fitted: false, placed: false };
    worker.onmessage = (ev: MessageEvent<FromLayout>) => {
      const { gen, positions } = ev.data;
      if (gen !== e.gen) return; // computed for a node set we have since replaced
      e.nodes.forEach((n, i) => {
        n.tx = positions[2 * i];
        n.ty = positions[2 * i + 1];
        if (!e.placed || n.x === undefined || n.y === undefined) {
          n.x = n.tx; // the first frame (or a new file) appears in place; later frames glide
          n.y = n.ty;
        }
      });
      e.placed = true;
      e.tree = null; // hit-test index is rebuilt lazily on the next pointer event
      // The worker warms the layout up before its first frame, so it is already close to final: frame it now.
      if (!e.fitted) {
        e.fitted = true;
        fit();
      }
      requestDraw();
    };
    worker.onerror = (ev) => console.error("[tracer] layout worker failed:", ev.message);
    engine.current = e;
    return () => {
      lastPositions.current = new Map(
        [...e.byId].flatMap(([id, n]) => (n.x !== undefined && n.y !== undefined ? [[id, { x: n.x, y: n.y }] as const] : [])),
      );
      worker.terminate();
      engine.current = null;
    };
  }, [graph, requestDraw, fit]);

  // Send visible nodes/links and force settings to the worker; any change re-heats the layout.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const nodes = [...visible].flatMap((id) => {
      const n = e.byId.get(id);
      return n ? [n] : [];
    });
    if (shownSet.current !== visible) {
      shownSet.current = visible;
      e.fitted = false; // a different set of files: frame it once the layout settles
    }
    for (const n of nodes) {
      n.r = settings.nodeSize * (2.5 + 1.6 * Math.sqrt(n.node.inDegree + n.node.outDegree));
      n.colorIndex = groupIndex.get(groupOf(n.node.path)) ?? 0;
    }
    e.maxR = Math.max(0, ...nodes.map((n) => n.r));
    e.tree = null;
    if (nodes.some((n) => n.x === undefined)) e.placed = false; // new files: wait for the warmed-up layout
    e.nodes = nodes;
    e.index = new Map(nodes.map((n, i) => [n.id, i]));
    e.links = visibleEdges.flatMap((x) => {
      const [source, target] = [e.byId.get(x.source), e.byId.get(x.target)];
      return source && target ? [{ source, target, key: edgeKey(x) }] : [];
    });
    const message: ToLayout = {
      type: "graph",
      gen: ++e.gen,
      nodes: nodes.map((n) => ({ id: n.id, r: n.r, x: n.x, y: n.y })),
      links: e.links.map((l) => [e.index.get((l.source as SimNode).id) ?? 0, e.index.get((l.target as SimNode).id) ?? 0]),
      settings,
      reduceMotion: reducedMotion(), // the worker then settles in one go and posts a single frame
    };
    e.worker.postMessage(message);
    requestDraw();
  }, [visible, visibleEdges, settings, groupIndex, groupOf, requestDraw, fit]);

  // A settled graph draws nothing on its own: repaint when the theme changes (the frame runs after App sets the attribute).
  useEffect(() => requestDraw(), [theme, requestDraw]);

  // Everything the renderer needs that React owns.
  useEffect(() => {
    scene.current = {
      selectedId,
      matches,
      cycleKeys: showCycles ? cycleKeys : null,
      labelZoom: settings.labelZoom,
      hubs,
      adjacency,
    };
    requestDraw();
  }, [selectedId, matches, showCycles, cycleKeys, settings.labelZoom, hubs, adjacency, requestDraw]);

  // Canvas: size, zoom/pan, node drag, hover, click, double-click.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = canvas?.parentElement;
    if (!canvas || !box) return;

    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // beyond 2x the extra pixels cost frames, not sharpness
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const hit = (ev: Event): SimNode | undefined => {
      const e = engine.current;
      if (!e) return undefined;
      e.tree ??= quadtree<SimNode>()
        .x((d) => d.x ?? 0)
        .y((d) => d.y ?? 0)
        .addAll(e.nodes);
      const [gx, gy] = transform.current.invert(pointer(ev, canvas));
      const tol = 4 / transform.current.k;
      const n = e.tree.find(gx, gy, e.maxR + tol);
      return n && Math.hypot((n.x ?? 0) - gx, (n.y ?? 0) - gy) <= n.r + tol ? n : undefined;
    };

    const z = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.03, 8])
      .on("zoom", (ev: { transform: ZoomTransform }) => {
        transform.current = ev.transform;
        requestDraw();
      });
    zoomBehavior.current = z;
    // d3-drag treats an undefined subject as "no drag here", so empty space falls through to zoom/pan.
    const nodeDrag = drag<HTMLCanvasElement, unknown, SimNode>()
      .subject((ev: { sourceEvent: Event }) => hit(ev.sourceEvent) as SimNode)
      .on("drag", (ev: { subject: SimNode; sourceEvent: Event }) => {
        const e = engine.current;
        const index = e?.index.get(ev.subject.id);
        if (!e || index === undefined) return;
        const [x, y] = transform.current.invert(pointer(ev.sourceEvent, canvas));
        ev.subject.x = ev.subject.tx = x; // move it here right away; the worker pins it and pulls the neighbors along
        ev.subject.y = ev.subject.ty = y;
        e.tree = null;
        requestDraw();
        e.worker.postMessage({ type: "drag", index, x, y } satisfies ToLayout);
      })
      .on("end", (ev: { subject: SimNode }) => {
        const index = engine.current?.index.get(ev.subject.id);
        if (index !== undefined) engine.current?.worker.postMessage({ type: "release", index } satisfies ToLayout);
      });
    const sel = select(canvas);
    sel.call(nodeDrag).call(z).on("dblclick.zoom", null);
    sel.call(z.transform, zoomIdentity.translate(size.current.w / 2, size.current.h / 2));

    // Hover hit tests run at most once per frame, however fast the pointer events arrive.
    let lastMove: PointerEvent | null = null;
    let moveFrame = 0;
    const onMove = (ev: PointerEvent) => {
      lastMove = ev;
      moveFrame ||= requestAnimationFrame(() => {
        moveFrame = 0;
        const id = lastMove ? (hit(lastMove)?.id ?? null) : null;
        if (id !== hover.current) {
          hover.current = id;
          canvas.style.cursor = id ? "pointer" : "";
          requestDraw();
        }
      });
    };
    const onLeave = () => {
      hover.current = null;
      requestDraw();
    };
    const onClick = (ev: MouseEvent) => setSelectedId(hit(ev)?.id ?? null);
    const onDblClick = (ev: MouseEvent) => {
      const n = hit(ev);
      if (n) onOpenSource(n.node.path);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("dblclick", onDblClick);
    return () => {
      ro.disconnect();
      sel.on(".zoom", null).on(".drag", null);
      canvas.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(moveFrame);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDblClick);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [graph, requestDraw, onOpenSource]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const focusNode = (id: string) => {
    setSelectedId(id);
    const n = engine.current?.byId.get(id);
    const canvas = canvasRef.current;
    if (n && canvas && zoomBehavior.current && visible.has(id)) {
      select(canvas).call(zoomBehavior.current.translateTo, n.x ?? 0, n.y ?? 0);
    }
  };

  const s = graph.summary;
  const selected = selectedId ? graph.nodes.find((n) => n.id === selectedId) : undefined;
  const set = <K extends keyof Settings>(k: K) => (ev: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((prev) => ({ ...prev, [k]: Number(ev.target.value) }));

  const zoomBy = (k: number) => {
    const canvas = canvasRef.current;
    if (canvas && zoomBehavior.current) select(canvas).call(zoomBehavior.current.scaleBy, k);
  };
  const toggleGroup = (g: string, shown: boolean) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (shown) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div className="graph-view">
      <div className="graph-canvas">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Import graph of ${graph.root}: ${visible.size} of ${graph.nodes.length} files shown, ${visibleEdges.length} imports. Use the search box and the details panel to explore with the keyboard.`}
        />
      </div>

      <aside className="graph-controls" aria-label="Graph controls">
        <div className="graph-stats" title={`${s.unresolvedCount} unresolved · ${s.externalCount} external imports`}>
          <strong>{graph.root}</strong>
          <span>
            {visible.size === graph.nodes.length ? s.fileCount : `${visible.size}/${s.fileCount}`} files · {s.edgeCount} imports
          </span>
        </div>

        <div>
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              value={query}
              placeholder="Find a file"
              aria-label="Find a file by path"
              onChange={(ev) => setQuery(ev.target.value)}
              onKeyDown={(ev) => {
                const first = [...matches][0];
                if (ev.key === "Enter" && first) focusNode(first);
              }}
            />
          </label>
          {query.trim() && (
            <div className="search-hint" aria-live="polite">
              {matches.size ? `${matches.size} match${matches.size === 1 ? "" : "es"} · Enter to jump` : "No matches"}
            </div>
          )}
        </div>

        <div className="chip-row" role="group" aria-label="Filters">
          <button type="button" className="chip-toggle" aria-pressed={hideTests} onClick={() => setHideTests((v) => !v)} title="Hide test files: *.test.*, *_test.*, test_*.py, *Test(s).*, *Spec.*, and test/, tests/, spec/, __tests__/ folders">
            <Icon name="beaker" />
            Hide tests
          </button>
          <button type="button" className="chip-toggle" aria-pressed={hideOrphans} onClick={() => setHideOrphans((v) => !v)} title="Hide files with no imports either way">
            <Icon name="circle-slash" />
            Hide orphans
          </button>
          <button
            type="button"
            className="chip-toggle"
            aria-pressed={showCycles}
            onClick={() => setShowCycles((v) => !v)}
            disabled={!cycles.length}
            title={cycles.length ? "Color the imports that form cycles" : "No import cycles"}
          >
            <Icon name="sync" />
            Cycles {cycles.length}
          </button>
        </div>

        {selectedId && (
          <div className="local-row">
            <span>Focus on selection</span>
            <div className="segmented" role="radiogroup" aria-label="Local graph depth">
              {[0, 1, 2, 3].map((d) => (
                <button key={d} type="button" role="radio" aria-selected={localDepth === d} aria-checked={localDepth === d} onClick={() => setLocalDepth(d)}>
                  {d === 0 ? "Off" : d}
                </button>
              ))}
            </div>
          </div>
        )}

        <details className="disclosure">
          <summary>
            <Icon name="chevron-right" />
            Folders
          </summary>
          <div className="disclosure-body folders" role="group" aria-label="Folders">
            {groups.map((g) => (
              <label key={g} className="folder-row">
                <input type="checkbox" checked={!hiddenGroups.has(g)} onChange={(ev) => toggleGroup(g, ev.target.checked)} />
                <span className="swatch" style={{ background: `var(--graph-${(groupIndex.get(g) ?? 0) + 1})` }} />
                <span>{g}</span>
                <span className="count">{groupCounts.get(g) ?? 0}</span>
              </label>
            ))}
          </div>
        </details>

        <details className="disclosure">
          <summary>
            <Icon name="chevron-right" />
            Layout settings
          </summary>
          <div className="disclosure-body">
            <Slider label="Center force" min={0} max={0.4} step={0.01} value={settings.center} onChange={set("center")} />
            <Slider label="Repel force" min={0} max={600} step={10} value={settings.repel} onChange={set("repel")} />
            <Slider label="Link force" min={0} max={1} step={0.05} value={settings.linkStrength} onChange={set("linkStrength")} />
            <Slider label="Link distance" min={10} max={300} step={5} value={settings.linkDistance} onChange={set("linkDistance")} />
            <Slider label="Node size" min={0.5} max={3} step={0.1} value={settings.nodeSize} onChange={set("nodeSize")} />
            <Slider label="Labels from zoom" min={0.2} max={4} step={0.1} value={settings.labelZoom} onChange={set("labelZoom")} />
            <button type="button" className="btn" onClick={() => setSettings(DEFAULTS)}>
              <Icon name="discard" />
              Reset
            </button>
          </div>
        </details>
      </aside>

      <div className="graph-fab" role="group" aria-label="Zoom">
        <IconButton icon="zoom-in" label="Zoom in" onClick={() => zoomBy(1.4)} />
        <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomBy(1 / 1.4)} />
        <IconButton icon="screen-full" label="Fit to view" onClick={fit} />
      </div>

      {selected && (
        <GraphSidePanel
          graph={graph}
          id={selected.id}
          visible={visible}
          onGo={focusNode}
          onOpenSource={onOpenSource}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function Slider(p: { label: string; min: number; max: number; step: number; value: number; onChange: (ev: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <label className="range">
      <span>
        {p.label} <span>{p.value}</span>
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={p.onChange} />
    </label>
  );
}

function GraphSidePanel(p: {
  graph: CodeGraph;
  id: string;
  visible: ReadonlySet<string>;
  onGo: (id: string) => void;
  onOpenSource: (path: string) => void;
  onClose: () => void;
}) {
  const node = p.graph.nodes.find((n) => n.id === p.id);
  const { imports, importedBy } = useMemo(() => neighborsOf(p.graph, p.id), [p.graph, p.id]);
  const impact = useMemo(() => fileImpact(p.id, p.graph.edges), [p.graph, p.id]);
  const unresolved = p.graph.summary.unresolved.filter((u) => u.from === p.id);
  if (!node) return null;
  const list = (title: string, ids: string[]) => (
    <section>
      <h3>
        {title} · {ids.length}
      </h3>
      {ids.length ? (
        <ul className="file-list">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" className="link-btn" onClick={() => p.onGo(id)} title={p.visible.has(id) ? id : `${id} (hidden by filters)`}>
                {id}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None</p>
      )}
    </section>
  );
  return (
    <aside className="side-panel" aria-label="File details">
      <header>
        <div className="chips">
          <span className="chip">{node.ext}</span>
          <span className="chip">{node.loc} lines</span>
        </div>
        <IconButton icon="close" label="Close details" onClick={p.onClose} />
      </header>
      <h2 className="mono">{node.path.slice(node.path.lastIndexOf("/") + 1)}</h2>
      <p className="mono muted" style={{ margin: "0 0 12px" }}>
        {node.folder}
      </p>
      <button type="button" className="btn" onClick={() => p.onOpenSource(node.path)}>
        <Icon name="go-to-file" />
        Open source
      </button>
      <section aria-label="Change impact">
        <h3>Change impact</h3>
        <p className="muted" title="Files that import this one, directly or through other files. From imports only: calls over HTTP, reflection or config are not seen.">
          {impact.dependents.length} direct · {impact.affected.length} affected · {impact.tests.length} test{impact.tests.length === 1 ? "" : "s"}
        </p>
      </section>
      {list("Imports", imports)}
      {list("Imported by", importedBy)}
      {impact.tests.length > 0 && list("Tests affected", impact.tests)}
      {impact.affected.length > importedBy.length && list("All affected files", impact.affected)}
      {unresolved.length > 0 && (
        <section>
          <h3>Unresolved · {unresolved.length}</h3>
          <ul className="file-list">
            {unresolved.map((u) => (
              <li key={u.specifier} className="mono muted">
                {u.specifier}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { CodeGraph } from "@tracer/core";
import type { HostAdapter } from "../host/HostAdapter";
import { groupColors, groupResolver } from "./graphModel";
import type { FromLayout, ToLayout } from "./layoutEngine";
// Inlined as a blob: worker. A webview cannot start a Worker from its (cross-origin) resource URL.
import LayoutWorker from "./layout.worker?worker&inline";

const PALETTE_SIZE = 6;
const SHELL_GAP = 90; // z distance between each top-level group's depth plane
const CLICK_SLOP = 4; // px of pointer movement still counted as a click, not a drag

type ColorSet = { bg: string; edge: string; text: string; palette: string[] };
function readColors(): ColorSet {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { bg: v("--bg"), edge: v("--graph-edge"), text: v("--text"), palette: Array.from({ length: PALETTE_SIZE }, (_, i) => v(`--graph-${i + 1}`)) };
}

/** Loads the graph through the host, then shows it as a 3D "Galaxy": files as spheres, one depth plane per
 * top-level folder/package. A lighter view than Graph: no filters, search or local-graph depth yet — rotate,
 * zoom, hover and click to open source. */
export function GalaxyView({ host, theme }: { host: HostAdapter; theme: string }) {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    host.loadGraph().then(
      (g) => !cancelled && setGraph(g),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
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
        <h2>Could not load the galaxy</h2>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!graph) return <div className="empty">Loading galaxy…</div>;
  if (!graph.nodes.length) return <div className="empty">This graph has no files. Check the --root you analyzed.</div>;
  return <Galaxy graph={graph} theme={theme} onOpenSource={openSource} />;
}

type NodeInfo = { id: string; path: string; label: string; r: number; groupIndex: number; z: number };

function Galaxy({ graph, theme, onOpenSource }: { graph: CodeGraph; theme: string; onOpenSource: (path: string) => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);
  // Positions from the graph just torn down, so a live refresh continues the layout instead of restarting it
  // (same fix as GraphView, D36): only genuinely new files miss an entry and get laid out fresh.
  const lastPositions = useRef(new Map<string, { x: number; y: number }>());

  useEffect(() => {
    const host = container.current;
    if (!host) return;

    const colors = readColors();
    const groupOf = groupResolver(graph.nodes.map((n) => n.path));
    const groups = [...new Set(graph.nodes.map((n) => groupOf(n.path)))].sort();
    const colorOf = groupColors(groups, colors.palette);
    const groupIndex = new Map(groups.map((g, i) => [g, i]));
    const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
    const counts = new Map<string, number>();
    for (const n of graph.nodes) counts.set(basename(n.path), (counts.get(basename(n.path)) ?? 0) + 1);
    const label = (p: string): string => ((counts.get(basename(p)) ?? 0) > 1 ? p.split("/").slice(-2).join("/") : basename(p));

    const infos: NodeInfo[] = graph.nodes.map((n) => {
      const gi = groupIndex.get(groupOf(n.path)) ?? 0;
      return {
        id: n.id,
        path: n.path,
        label: label(n.path),
        r: 1.6 + 1.1 * Math.sqrt(n.inDegree + n.outDegree),
        groupIndex: gi,
        z: (gi - (groups.length - 1) / 2) * SHELL_GAP,
      };
    });
    const indexById = new Map(infos.map((n, i) => [n.id, i]));
    const edges = graph.edges.flatMap((e) => {
      const a = indexById.get(e.source);
      const b = indexById.get(e.target);
      return a !== undefined && b !== undefined ? [[a, b] as const] : [];
    });

    // ---- Three.js scene -------------------------------------------------------------------------------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.bg || "#1e1e1e");
    const camera = new THREE.PerspectiveCamera(55, 1, 1, 5000);
    camera.position.set(0, 0, Math.max(300, 40 * Math.sqrt(infos.length)));
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.6;

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(1, 1, 1);
    scene.add(key);

    const geometry = new THREE.SphereGeometry(1, 12, 10);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geometry, material, infos.length);
    const baseColor = new THREE.Color(); // setColorAt below creates mesh.instanceColor on first call
    infos.forEach((n, i) => {
      baseColor.set(colorOf.get(groupOf(n.path)) ?? "#888");
      mesh.setColorAt(i, baseColor);
    });
    scene.add(mesh);

    const edgeGeometry = new THREE.BufferGeometry();
    const edgePositions = new Float32Array(edges.length * 2 * 3);
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({ color: colors.edge || "#888", transparent: true, opacity: 0.35 });
    const lines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(lines);

    const dummy = new THREE.Object3D();
    const positions = new Map<string, { x: number; y: number; z: number }>(); // current, for edge updates + raycasting
    const place = (i: number, x: number, y: number, z: number) => {
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(infos[i]?.r ?? 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    };
    const applyPositions = () => {
      mesh.instanceMatrix.needsUpdate = true;
      const arr = edgeGeometry.attributes.position as THREE.BufferAttribute;
      edges.forEach(([a, b], i) => {
        const pa = positions.get(infos[a]?.id ?? "");
        const pb = positions.get(infos[b]?.id ?? "");
        if (!pa || !pb) return;
        arr.setXYZ(i * 2, pa.x, pa.y, pa.z);
        arr.setXYZ(i * 2 + 1, pb.x, pb.y, pb.z);
      });
      arr.needsUpdate = true;
    };

    // ---- Layout: the same 2D force engine as Graph, read as x/y on this node's depth plane -------------
    const worker = new LayoutWorker();
    worker.onmessage = (ev: MessageEvent<FromLayout>) => {
      const { positions: pos } = ev.data;
      infos.forEach((n, i) => {
        const x = pos[2 * i] ?? 0;
        const y = pos[2 * i + 1] ?? 0;
        positions.set(n.id, { x, y, z: n.z });
        place(i, x, y, n.z);
      });
      applyPositions();
    };
    worker.onerror = (ev) => console.error("[tracer] galaxy layout worker failed:", ev.message);
    const message: ToLayout = {
      type: "graph",
      gen: 0,
      nodes: infos.map((n) => {
        const prior = lastPositions.current.get(n.id);
        return { id: n.id, r: n.r, x: prior?.x, y: prior?.y };
      }),
      links: edges.map(([a, b]) => [a, b]),
      settings: { center: 0.05, repel: 160, linkStrength: 0.4, linkDistance: 60 },
      reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
    worker.postMessage(message);

    // ---- Resize, render loop ---------------------------------------------------------------------------
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // ---- Picking: hover highlights + shows a label, click opens source. A drag (OrbitControls) is not a click. ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered = -1;
    let down: { x: number; y: number } | null = null;
    const highlight = new THREE.Color();
    const setHoverColor = (i: number, hovered: boolean) => {
      const n = infos[i];
      if (!n) return;
      highlight.set(colorOf.get(groupOf(n.path)) ?? "#888");
      if (hovered) highlight.offsetHSL(0, 0, 0.18);
      mesh.setColorAt(i, highlight);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    const pick = (ev: PointerEvent): number => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(mesh)[0]?.instanceId ?? -1;
    };
    const onMove = (ev: PointerEvent) => {
      const i = pick(ev);
      if (i !== hovered) {
        if (hovered >= 0) setHoverColor(hovered, false);
        hovered = i;
        if (i >= 0) setHoverColor(i, true);
      }
      const n = i >= 0 ? infos[i] : undefined;
      setHover(n ? { label: n.label, x: ev.clientX, y: ev.clientY } : null);
    };
    const onDown = (ev: PointerEvent) => (down = { x: ev.clientX, y: ev.clientY });
    const onUp = (ev: PointerEvent) => {
      const moved = down ? Math.hypot(ev.clientX - down.x, ev.clientY - down.y) : Infinity;
      down = null;
      if (moved > CLICK_SLOP) return; // a drag that rotated the camera, not a click
      const i = pick(ev);
      const n = i >= 0 ? infos[i] : undefined;
      if (n) onOpenSource(n.path);
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointerleave", () => setHover(null));

    return () => {
      lastPositions.current = new Map([...positions].map(([id, p]) => [id, { x: p.x, y: p.y }]));
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      worker.terminate();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
    // theme is read once per mount (colors.bg etc.) via readColors(), so a theme change remounts the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, theme]);

  return (
    <div className="galaxy-area" style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={container} style={{ width: "100%", height: "100%" }} />
      {hover && (
        <div className="galaxy-tooltip" style={{ position: "fixed", left: hover.x + 12, top: hover.y + 12, pointerEvents: "none" }}>
          {hover.label}
        </div>
      )}
    </div>
  );
}

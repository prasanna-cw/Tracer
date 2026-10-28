import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { toBlob, toSvg } from "html-to-image";
import { toJsonCanvas, type Diagram } from "@tracer/core";
import { DiagramCanvas } from "./canvas/DiagramCanvas";
import { historyReducer, initHistory } from "./canvas/history";
import type { Highlight } from "./canvas/toFlow";
import { WalkthroughBar } from "./canvas/WalkthroughBar";
import type { HostAdapter, HostEnv } from "./host/HostAdapter";
import { SidePanel } from "./ui/SidePanel";
import { Toasts, useToasts } from "./ui/Toasts";
import { TracerMark } from "./ui/Icon";
import { Toolbar, ViewTabs, type SaveState, type Theme, type View } from "./ui/Toolbar";
import { MapView } from "./graph/MapView";
import { GraphView } from "./graph/GraphView";
// Three.js is ~500 kB: loaded only if the Galaxy tab is actually opened, not on every Map/Graph/Flow load.
const GalaxyView = lazy(() => import("./graph/GalaxyView").then((m) => ({ default: m.GalaxyView })));

const EMPTY: Diagram = { version: 1, title: "", nodes: [], edges: [] };
const DEFAULT_ID = "save-flow.diagram.json";
const GRAPH_HASH = "#graph";
const MAP_HASH = "#map";
const GALAXY_HASH = "#galaxy";
const THEME_KEY = "tracer.theme";
const STEP_MS = 2500;

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // storage blocked: fall through to the OS preference
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

type Props = {
  /** Called once; `notify` shows a toast. Must be a stable function (defined outside React). */
  createHost: (notify: (message: string) => void) => HostAdapter;
  /** web: the standalone prototype. editor: one document owned by the host (VS Code). graph: only the graph. */
  env: HostEnv;
  initialTheme?: Theme;
  /** Use the host's own colors (VS Code theme) for the chrome. */
  initialNative?: boolean;
};

export function App({ createHost, env, initialTheme, initialNative = false }: Props) {
  const [toasts, notify, dismiss] = useToasts();
  const host = useMemo(() => createHost(notify), [createHost, notify]);
  const web = env.kind === "web";
  // In the VS Code editor the host owns the document: undo/redo, dirty state and save go through it.
  const hostOwnsDocument = env.kind === "editor";

  const [diagrams, setDiagrams] = useState<{ id: string; title: string }[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(env.kind === "editor" || env.kind === "flow" ? env.documentId : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadSeq, setLoadSeq] = useState(0); // remounts the canvas per load so it fits the new diagram
  const [h, dispatch] = useReducer(historyReducer, EMPTY, initHistory);
  const diagram = h.present;
  const dirty = !hostOwnsDocument && h.present !== h.saved; // VS Code shows its own dirty marker on the tab
  const synced = useRef<Diagram | null>(null); // last diagram the host has seen (editor mode)

  const [view, setView] = useState<View>(() => {
    if (env.kind === "graph") return env.view ?? "map";
    if (web && location.hash === GRAPH_HASH) return "graph";
    if (web && location.hash === MAP_HASH) return "map";
    if (web && location.hash === GALAXY_HASH) return "galaxy";
    return "diagram";
  });
  const [theme, setTheme] = useState<Theme>(() => initialTheme ?? readTheme());
  const [native, setNative] = useState(initialNative);
  const [snap, setSnap] = useState(false);
  const [minimap, setMinimap] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  // --- loading ---------------------------------------------------------------
  useEffect(() => {
    if (!web) return; // the editor shows exactly one document
    void host.listDiagrams().then((list) => {
      setDiagrams(list);
      const fromHash = decodeURIComponent(location.hash.slice(1));
      const pick = [fromHash, DEFAULT_ID].find((id) => list.some((d) => d.id === id));
      setCurrentId(pick ?? list[0]?.id ?? null);
    });
  }, [host, web]);

  useEffect(() => {
    if (!currentId || env.kind === "graph") return;
    let cancelled = false;
    host.loadDiagram(currentId).then(
      (d) => {
        if (cancelled) return;
        dispatch({ type: "load", diagram: d });
        synced.current = d;
        setLoadSeq((n) => n + 1);
        setLoadError(null);
        setSelectedId(null);
        setStepIndex(null);
        setPlaying(false);
        host.reportStatus?.({ id: currentId, state: "loaded", nodeCount: d.nodes.length });
        if (web && location.hash !== GRAPH_HASH) history.replaceState(null, "", `#${encodeURIComponent(currentId)}`);
      },
      (e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setLoadError(message);
        host.reportStatus?.({ id: currentId, state: "error", detail: message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [currentId, host, web, env.kind]);

  // Editor mode: every committed change goes to the host document (one VS Code undo step each)...
  useEffect(() => {
    if (!hostOwnsDocument || !currentId || loadSeq === 0 || h.present === synced.current) return;
    synced.current = h.present;
    host.applyEdit?.(currentId, h.present);
  }, [h.present, hostOwnsDocument, currentId, loadSeq, host]);

  // ...and changes made elsewhere (VS Code undo/redo, a text editor, an Obsidian save) come back in.
  useEffect(() => {
    if (!hostOwnsDocument) return;
    const offChanged = host.onDocumentChanged?.((id, d) => {
      if (id !== currentId) return;
      synced.current = d; // already in the document: don't echo it back
      dispatch({ type: "replace", diagram: d });
      setLoadError(null);
      setLoadSeq((n) => n || 1);
    });
    const offInvalid = host.onDocumentInvalid?.((id, errors) => {
      if (id === currentId) setLoadError(`The document no longer parses:\n${errors.join("\n")}`);
    });
    return () => {
      offChanged?.();
      offInvalid?.();
    };
  }, [host, hostOwnsDocument, currentId]);

  const open = (id: string) => {
    if (id === currentId) return;
    if (dirty && !window.confirm("Discard unsaved changes to this diagram?")) return;
    setCurrentId(id);
  };

  // The hash is the route (web only): #graph, or #<diagram file>. Back/forward and pasted links work.
  useEffect(() => {
    if (!web) return;
    const onHash = () => {
      if (location.hash === GRAPH_HASH || location.hash === MAP_HASH || location.hash === GALAXY_HASH) {
        setView(location.hash === GRAPH_HASH ? "graph" : location.hash === MAP_HASH ? "map" : "galaxy");
        return;
      }
      const id = decodeURIComponent(location.hash.slice(1));
      if (!diagrams.some((d) => d.id === id)) return;
      setView("diagram");
      if (id === currentId) return;
      if (dirty && !window.confirm("Discard unsaved changes to this diagram?")) {
        history.replaceState(null, "", `#${encodeURIComponent(currentId ?? "")}`);
        return;
      }
      setCurrentId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [currentId, diagrams, dirty, web]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // --- theme -------------------------------------------------------------------
  useEffect(
    () =>
      host.onThemeChanged?.((t, n) => {
        setTheme(t);
        setNative(n);
      }),
    [host],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.native = String(native);
    if (!web) return; // in VS Code the theme comes from VS Code and the codemap.theme setting
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage blocked (private mode, policy): theme just won't persist
    }
  }, [theme, native, web]);

  // --- save / export -----------------------------------------------------------
  const save = useCallback(async () => {
    if (!currentId) return;
    const snapshot = diagram;
    setSaveState("saving");
    try {
      await host.saveDiagram(currentId, snapshot);
      dispatch({ type: "saved", diagram: snapshot });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (e) {
      setSaveState("idle");
      if ((e as Error).name !== "AbortError") notify(`Save failed: ${(e as Error).message}`);
    }
  }, [currentId, diagram, host, notify]);

  const exportAs = async (kind: "canvas" | "svg" | "png") => {
    const base = (currentId ?? "diagram").replace(/^.*[\\/]/, "").replace(/\.(diagram\.json|json|canvas)$/i, "");
    try {
      if (kind === "canvas") {
        await host.exportFile(`${base}.canvas`, JSON.stringify(toJsonCanvas(diagram), null, "\t") + "\n");
        return;
      }
      const el = document.querySelector<HTMLElement>(".react-flow");
      if (!el) throw new Error("canvas not mounted");
      const options = {
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
        // The current view, without the chrome floating over it.
        filter: (n: Node) => !(n instanceof HTMLElement && n.classList.contains("react-flow__panel")),
      };
      const blob =
        kind === "png" ? await toBlob(el, { ...options, pixelRatio: 2 }) : await (await fetch(await toSvg(el, options))).blob();
      if (!blob) throw new Error("renderer returned nothing");
      await host.exportFile(`${base}.${kind}`, blob);
    } catch (e) {
      if ((e as Error).name !== "AbortError") notify(`Export failed: ${(e as Error).message}`);
    }
  };

  // --- walkthrough ---------------------------------------------------------------
  const steps = useMemo(() => diagram.steps ?? [], [diagram.steps]);
  const step = stepIndex !== null ? steps[stepIndex] : undefined;
  const highlight: Highlight = useMemo(
    () => (step ? { nodeIds: new Set(step.nodeIds), edgeIds: new Set(step.edgeIds ?? []) } : null),
    [step],
  );
  const focusIds = useMemo(() => step?.nodeIds ?? null, [step]);
  const go = useCallback(
    (delta: number) => setStepIndex((i) => (i === null ? i : Math.min(steps.length - 1, Math.max(0, i + delta)))),
    [steps.length],
  );
  const exitWalkthrough = () => {
    setStepIndex(null);
    setPlaying(false);
  };

  useEffect(() => {
    if (!playing || stepIndex === null) return;
    const t = setTimeout(() => (stepIndex + 1 < steps.length ? setStepIndex(stepIndex + 1) : setPlaying(false)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, stepIndex, steps.length]);

  // --- keyboard ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== "diagram") return; // the graph view handles its own keys
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // In VS Code, Ctrl+S/Z/Y are VS Code's (save and undo the document): leave them alone.
      if (!hostOwnsDocument) {
        if (mod && key === "s") {
          e.preventDefault(); // even while typing: never let the browser "save page"
          void save();
          return;
        }
        if (isTyping(e.target)) return; // text fields keep their own undo and arrows
        if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
          e.preventDefault();
          dispatch({ type: "redo" });
          return;
        }
        if (mod && key === "z") {
          e.preventDefault();
          dispatch({ type: "undo" });
          return;
        }
      }
      if (isTyping(e.target)) return;
      if (stepIndex !== null && e.key === "ArrowRight") go(1);
      else if (stepIndex !== null && e.key === "ArrowLeft") go(-1);
      else if (stepIndex !== null && e.key === "Escape") exitWalkthrough();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, go, stepIndex, view, hostOwnsDocument]);

  const selected = selectedId ? diagram.nodes.find((n) => n.id === selectedId) : undefined;
  const ready = loadSeq > 0;

  return (
    <div className="app">
      {env.kind !== "graph" && (
        <Toolbar
          mode={web ? "web" : "editor"}
          view={view}
          onView={(v) =>
            (location.hash = v === "graph" ? GRAPH_HASH : v === "map" ? MAP_HASH : v === "galaxy" ? GALAXY_HASH : encodeURIComponent(currentId ?? DEFAULT_ID))
          }
          diagrams={diagrams}
          currentId={currentId}
          onOpen={open}
          canUndo={hostOwnsDocument || h.past.length > 0}
          canRedo={hostOwnsDocument || h.future.length > 0}
          onUndo={() => (hostOwnsDocument ? host.runCommand?.("undo") : dispatch({ type: "undo" }))}
          onRedo={() => (hostOwnsDocument ? host.runCommand?.("redo") : dispatch({ type: "redo" }))}
          dirty={dirty}
          saveState={saveState}
          onSave={() => void save()}
          onExport={(k) => void exportAs(k)}
          hasSteps={steps.length > 0}
          walkthrough={stepIndex !== null}
          onToggleWalkthrough={() => (stepIndex === null ? setStepIndex(0) : exitWalkthrough())}
          snap={snap}
          onToggleSnap={() => setSnap((s) => !s)}
          minimap={minimap}
          onToggleMinimap={() => setMinimap((m) => !m)}
          theme={theme}
          onTheme={setTheme}
        />
      )}
      {env.kind === "graph" && (
        <header className="toolbar" role="toolbar" aria-label="Tracer">
          <span className="brand">
            <TracerMark />
            Tracer
          </span>
          <ViewTabs view={view} views={["map", "graph", "galaxy"]} onView={setView} />
        </header>
      )}
      {view === "graph" ? (
        <main className="workspace">
          <GraphView host={host} theme={theme} />
        </main>
      ) : view === "map" ? (
        <main className="workspace">
          <MapView host={host} dark={theme === "dark"} />
        </main>
      ) : view === "galaxy" ? (
        <main className="workspace">
          <Suspense fallback={<div className="empty">Loading galaxy…</div>}>
            <GalaxyView host={host} theme={theme} />
          </Suspense>
        </main>
      ) : (
        <main className="workspace">
          <div className="canvas-area">
            {loadError ? (
              <div className="empty" role="alert">
                <h2>Could not open this diagram</h2>
                <pre>{loadError}</pre>
              </div>
            ) : !ready ? (
              <div className="empty">Loading…</div>
            ) : (
              <>
                {diagram.nodes.length === 0 && <div className="empty overlay">This diagram is empty.</div>}
                <ReactFlowProvider key={loadSeq}>
                  <DiagramCanvas
                    diagram={diagram}
                    dispatch={dispatch}
                    highlight={highlight}
                    focusIds={focusIds}
                    snap={snap}
                    minimap={minimap}
                    dots={theme === "dark"}
                    onSelect={setSelectedId}
                  />
                </ReactFlowProvider>
                {step && stepIndex !== null && (
                  <WalkthroughBar
                    step={step}
                    index={stepIndex}
                    count={steps.length}
                    playing={playing}
                    onPrev={() => go(-1)}
                    onNext={() => go(1)}
                    onTogglePlay={() => setPlaying((p) => !p)}
                    onExit={exitWalkthrough}
                  />
                )}
              </>
            )}
          </div>
          {selected && (
            <SidePanel
              node={selected}
              editable={stepIndex === null}
              onEditText={(text) => dispatch({ type: "edit", id: selected.id, patch: { text } })}
              onOpenSource={(path, line) => void host.openSource(path, line)}
              onClose={() => setSelectedId(null)}
            />
          )}
        </main>
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

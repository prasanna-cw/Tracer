import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { toBlob, toSvg } from "html-to-image";
import { toJsonCanvas, type Diagram } from "@codemap/core";
import { DiagramCanvas } from "./canvas/DiagramCanvas";
import { historyReducer, initHistory } from "./canvas/history";
import type { Highlight } from "./canvas/toFlow";
import { WalkthroughBar } from "./canvas/WalkthroughBar";
import { WebHost } from "./host/WebHost";
import { SidePanel } from "./ui/SidePanel";
import { Toasts, useToasts } from "./ui/Toasts";
import { Toolbar, type SaveState, type Theme, type View } from "./ui/Toolbar";
import { GraphView } from "./graph/GraphView";

const EMPTY: Diagram = { version: 1, title: "", nodes: [], edges: [] };
const DEFAULT_ID = "save-flow.diagram.json";
const GRAPH_HASH = "#graph";
const THEME_KEY = "codemap.theme";
const STEP_MS = 2500;

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "obsidian" ? "obsidian" : "clean";
  } catch {
    return "clean";
  }
}

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function App() {
  const [toasts, notify, dismiss] = useToasts();
  const host = useMemo(() => new WebHost(notify), [notify]);

  const [diagrams, setDiagrams] = useState<{ id: string; title: string }[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadSeq, setLoadSeq] = useState(0); // remounts the canvas per load so it fits the new diagram
  const [h, dispatch] = useReducer(historyReducer, EMPTY, initHistory);
  const diagram = h.present;
  const dirty = h.present !== h.saved;

  const [view, setView] = useState<View>(() => (location.hash === GRAPH_HASH ? "graph" : "diagram"));
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [snap, setSnap] = useState(false);
  const [minimap, setMinimap] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  // --- loading ---------------------------------------------------------------
  useEffect(() => {
    void host.listDiagrams().then((list) => {
      setDiagrams(list);
      const fromHash = decodeURIComponent(location.hash.slice(1));
      const pick = [fromHash, DEFAULT_ID].find((id) => list.some((d) => d.id === id));
      setCurrentId(pick ?? list[0]?.id ?? null);
    });
  }, [host]);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    host.loadDiagram(currentId).then(
      (d) => {
        if (cancelled) return;
        dispatch({ type: "load", diagram: d });
        setLoadSeq((n) => n + 1);
        setLoadError(null);
        setSelectedId(null);
        setStepIndex(null);
        setPlaying(false);
        if (location.hash !== GRAPH_HASH) history.replaceState(null, "", `#${encodeURIComponent(currentId)}`);
      },
      (e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [currentId, host]);

  const open = (id: string) => {
    if (id === currentId) return;
    if (dirty && !window.confirm("Discard unsaved changes to this diagram?")) return;
    setCurrentId(id);
  };

  // The hash is the route: #graph, or #<diagram file>. Back/forward and pasted links work.
  useEffect(() => {
    const onHash = () => {
      if (location.hash === GRAPH_HASH) {
        setView("graph");
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
  }, [currentId, diagrams, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // --- theme -------------------------------------------------------------------
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage blocked (private mode, policy): theme just won't persist
    }
  }, [theme]);

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
    const base = (currentId ?? "diagram").replace(/\.(diagram\.json|json|canvas)$/i, "");
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
      notify(`Export failed: ${(e as Error).message}`);
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
      if (mod && key === "s") {
        e.preventDefault(); // even while typing: never let the browser "save page"
        void save();
        return;
      }
      if (isTyping(e.target)) return; // text fields keep their own undo and arrows
      if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (mod && key === "z") {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if (stepIndex !== null && e.key === "ArrowRight") {
        go(1);
      } else if (stepIndex !== null && e.key === "ArrowLeft") {
        go(-1);
      } else if (stepIndex !== null && e.key === "Escape") {
        setStepIndex(null);
        setPlaying(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, go, stepIndex, view]);

  const selected = selectedId ? diagram.nodes.find((n) => n.id === selectedId) : undefined;
  const ready = loadSeq > 0;

  return (
    <div className="app">
      <Toolbar
        view={view}
        onView={(v) => (location.hash = v === "graph" ? GRAPH_HASH : encodeURIComponent(currentId ?? DEFAULT_ID))}
        diagrams={diagrams}
        currentId={currentId}
        onOpen={open}
        canUndo={h.past.length > 0}
        canRedo={h.future.length > 0}
        onUndo={() => dispatch({ type: "undo" })}
        onRedo={() => dispatch({ type: "redo" })}
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
      {view === "graph" ? (
        <main className="workspace">
          <GraphView host={host} theme={theme} />
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
                    dots={theme === "obsidian"}
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

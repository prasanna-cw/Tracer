import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { activateMapItem, buildMap, initialMapState, revealInMap, type CodeGraph, type MapState } from "@tracer/core";
import { DiagramCanvas } from "../canvas/DiagramCanvas";
import type { HostAdapter } from "../host/HostAdapter";
import { SidePanel } from "../ui/SidePanel";
import { Icon, IconButton } from "../ui/Icon";

const noop = (): void => undefined;

/** Loads the workspace graph through the host, then shows it as the map. */
export function MapView({ host, dark }: { host: HostAdapter; dark: boolean }) {
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    host.loadGraph().then(
      (g) => !cancelled && setGraph(g),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [host]);
  if (error) {
    return (
      <div className="empty" role="alert">
        <h2>Could not load the workspace</h2>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!graph) return <div className="empty">Loading…</div>;
  if (!graph.nodes.length) return <div className="empty">No source files were found in this workspace.</div>;
  return <MapExplorer graph={graph} dark={dark} onOpenSource={(path) => void host.openSource(path)} />;
}

function MapExplorer({ graph, dark, onOpenSource }: { graph: CodeGraph; dark: boolean; onOpenSource: (path: string) => void }) {
  const [state, setState] = useState<MapState>(() => initialMapState(graph));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const result = useMemo(() => buildMap(graph, state), [graph, state]);

  const activate = useCallback(
    (id: string) => {
      const item = result.items.get(id);
      if (!item || item.kind === "file") return;
      const next = activateMapItem(state, id, item);
      setState(next);
      // After the new layout is drawn, frame the folder and what it just revealed.
      const after = buildMap(graph, next);
      const children = after.diagram.edges.filter((e) => e.fromNode === id && e.id.startsWith("c")).map((e) => e.toNode);
      setFocus([id, ...children.slice(0, 12)]);
    },
    [graph, result, state],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? graph.nodes.filter((n) => n.path.toLowerCase().includes(q)).slice(0, 8) : [];
  }, [graph, query]);
  const reveal = (path: string) => {
    setState((s) => revealInMap(graph, s, path));
    // Frame the file with the files it imports, not the file alone (a lone card would fill the screen).
    setFocus([`f:${path}`, ...graph.edges.filter((e) => e.source === path).slice(0, 6).map((e) => `f:${e.target}`)]);
    setSelectedId(`f:${path}`);
    setQuery("");
  };

  // The selected card and everything it is linked to stay bright; the rest of the map dims, so one folder's
  // imports can be followed through a crowded map.
  const highlight = useMemo(() => {
    if (!selectedId || !result.diagram.nodes.some((n) => n.id === selectedId)) return null;
    const nodeIds = new Set([selectedId]);
    const edgeIds = new Set<string>();
    for (const e of result.diagram.edges) {
      if (e.fromNode !== selectedId && e.toNode !== selectedId) continue;
      edgeIds.add(e.id);
      nodeIds.add(e.fromNode);
      nodeIds.add(e.toNode);
    }
    return { nodeIds, edgeIds };
  }, [result, selectedId]);

  const selected = selectedId ? result.diagram.nodes.find((n) => n.id === selectedId) : undefined;
  const c = result.counts;
  return (
    <div className="map-view">
      <div className="canvas-area">
        <ReactFlowProvider>
          <DiagramCanvas
            diagram={result.diagram}
            dispatch={noop}
            highlight={highlight}
            focusIds={focus}
            snap={false}
            minimap={false}
            dots={dark}
            onSelect={setSelectedId}
            onActivate={activate}
          />
        </ReactFlowProvider>
        <div className="map-bar">
          <div className="search">
            <Icon name="search" />
            <input type="search" value={query} placeholder="Find a file" aria-label="Find a file and show it in the map" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && matches[0] && reveal(matches[0].path)} />
            {matches.length > 0 && (
              <ul className="search-results" role="listbox">
                {matches.map((m) => (
                  <li key={m.path}>
                    <button type="button" role="option" aria-selected="false" onClick={() => reveal(m.path)} title={m.path}>
                      {m.path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <span className="map-count" title="Folders and files currently drawn, and the import links between them">
            {c.folders} folders · {c.files} files · {c.imports} links
          </span>
          <IconButton icon="collapse-all" label="Collapse all" onClick={() => setState({ expanded: new Set(["d:"]), pages: new Map() })} />
          <IconButton icon="refresh" label="Reset the map" onClick={() => setState(initialMapState(graph))} />
        </div>
        <p className="map-hint">Click a folder to open or close it. Click a file for details.</p>
      </div>
      {selected && selected.id.startsWith("f:") && (
        <SidePanel
          node={selected}
          editable={false}
          onEditText={noop}
          onOpenSource={(path) => onOpenSource(path)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type NodeChange,
} from "@xyflow/react";
import type { Diagram } from "@codemap/core";
import { EdgeMarkers, edgeTypes } from "./DiagramEdge";
import type { HistoryAction } from "./history";
import { CanvasActions, nodeTypes } from "./nodes";
import { mergeFlowNodes, paletteOf, toFlowEdges, type FlowNode, type Highlight } from "./toFlow";

export const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Props = {
  diagram: Diagram;
  dispatch: (a: HistoryAction) => void;
  highlight: Highlight;
  /** Node ids to frame (walkthrough step). */
  focusIds: readonly string[] | null;
  snap: boolean;
  minimap: boolean;
  dots: boolean;
  onSelect: (id: string | null) => void;
};

const SNAP: [number, number] = [20, 20];

/** Mount with `key={diagramId}` so switching diagrams resets viewport and selection. */
export function DiagramCanvas({ diagram, dispatch, highlight, focusIds, snap, minimap, dots, onSelect }: Props) {
  const walkthrough = highlight !== null;
  const [nodes, setNodes] = useState<FlowNode[]>(() => mergeFlowNodes([], diagram, highlight));
  // Re-sync when the diagram (undo, edit, load) or highlight changes: adjust state during render, not in an effect.
  const [synced, setSynced] = useState({ diagram, highlight });
  if (synced.diagram !== diagram || synced.highlight !== highlight) {
    setSynced({ diagram, highlight });
    setNodes((prev) => mergeFlowNodes(prev, diagram, highlight));
  }
  const edges = useMemo(() => toFlowEdges(diagram, highlight), [diagram, highlight]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      // Commit when a move finishes (drag end, or a keyboard nudge which has no drag phase): one undo step each.
      const moves = changes.flatMap((c) =>
        c.type === "position" && !c.dragging && c.position ? [{ id: c.id, x: c.position.x, y: c.position.y }] : [],
      );
      if (moves.length) dispatch({ type: "move", moves });
      for (const c of changes) if (c.type === "select" && c.selected) onSelect(c.id);
    },
    [dispatch, onSelect],
  );

  // Drag end does not always carry a final position change; commit from the drop event too (no-op if already applied).
  const onNodeDragStop = useCallback(
    (_e: unknown, _n: FlowNode, dragged: FlowNode[]) =>
      dispatch({ type: "move", moves: dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })) }),
    [dispatch],
  );

  const actions = useMemo(
    () => ({ editText: (id: string, text: string) => dispatch({ type: "edit", id, patch: { text } }), editable: !walkthrough }),
    [dispatch, walkthrough],
  );

  const rf = useReactFlow();
  useEffect(() => {
    if (!focusIds?.length) return;
    void rf.fitView({
      nodes: focusIds.map((id) => ({ id })),
      duration: prefersReducedMotion() ? 0 : 600,
      padding: 0.35,
      maxZoom: 1.2,
    });
  }, [focusIds, rf]);

  return (
    <CanvasActions.Provider value={actions}>
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={!walkthrough}
        nodesConnectable={false}
        edgesFocusable={false}
        elevateNodesOnSelect={false}
        disableKeyboardA11y={walkthrough} // arrows step the walkthrough instead of nudging nodes
        zoomOnDoubleClick={false}
        deleteKeyCode={null} // deleting nodes is not a feature yet; don't let Backspace silently drop them
        snapToGrid={snap}
        snapGrid={SNAP}
        minZoom={0.1}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.1 }}
      >
        <EdgeMarkers />
        {dots && <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />}
        <Controls showInteractive={false} />
        {minimap && <MiniMap pannable zoomable nodeClassName={(n) => `cat-${paletteOf((n as FlowNode).data).family}`} />}
      </ReactFlow>
    </CanvasActions.Provider>
  );
}

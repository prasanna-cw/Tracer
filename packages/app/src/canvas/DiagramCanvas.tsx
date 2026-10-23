import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { groupMembers, moveGroup, type Diagram } from "@tracer/core";
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

type GroupDrag = { x: number; y: number; members: { id: string; x: number; y: number }[] };

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

  // Group drags carry their members (geometric membership, snapshotted when the drag starts).
  const groupDrags = useRef(new Map<string, GroupDrag>());

  const onNodeDragStart = useCallback(
    (_e: unknown, _n: FlowNode, dragged: FlowNode[]) => {
      const draggedIds = new Set(dragged.map((n) => n.id));
      groupDrags.current.clear();
      for (const g of dragged) {
        if (g.data.type !== "group") continue;
        const members = groupMembers(diagram.nodes, g.id).filter((m) => !draggedIds.has(m.id));
        groupDrags.current.set(g.id, { x: g.data.x, y: g.data.y, members: members.map(({ id, x, y }) => ({ id, x, y })) });
      }
    },
    [diagram.nodes],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const extra: NodeChange<FlowNode>[] = [];
      for (const c of changes) {
        if (c.type !== "position" || !c.position) continue;
        const drag = groupDrags.current.get(c.id);
        if (drag) {
          for (const m of drag.members) {
            const position = { x: m.x + c.position.x - drag.x, y: m.y + c.position.y - drag.y };
            extra.push({ type: "position", id: m.id, position, dragging: c.dragging });
          }
        } else if (!c.dragging && diagram.nodes.some((n) => n.id === c.id && n.type === "group")) {
          // Keyboard nudge of a group: no drag session, move members from the committed positions.
          for (const m of moveGroup(diagram.nodes, c.id, c.position.x, c.position.y).slice(1)) {
            extra.push({ type: "position", id: m.id, position: { x: m.x, y: m.y } });
          }
        }
      }
      const all = extra.length ? [...changes, ...extra] : changes;
      setNodes((ns) => applyNodeChanges(all, ns));
      // Commit when a move finishes (drag end, or a keyboard nudge which has no drag phase): one undo step each.
      const moves = new Map<string, { id: string; x: number; y: number }>();
      for (const c of all) if (c.type === "position" && !c.dragging && c.position) moves.set(c.id, { id: c.id, ...c.position });
      if (moves.size) dispatch({ type: "move", moves: [...moves.values()] });
      for (const c of changes) if (c.type === "select" && c.selected) onSelect(c.id);
    },
    [diagram.nodes, dispatch, onSelect],
  );

  // Drag end does not always carry a final position change; commit from the drop event too (no-op if already applied).
  const onNodeDragStop = useCallback(
    (_e: unknown, _n: FlowNode, dragged: FlowNode[]) => {
      const moves = new Map(dragged.map((n) => [n.id, { id: n.id, x: n.position.x, y: n.position.y }]));
      for (const [groupId, drag] of groupDrags.current) {
        const g = moves.get(groupId);
        if (!g) continue;
        for (const m of drag.members) moves.set(m.id, { id: m.id, x: m.x + g.x - drag.x, y: m.y + g.y - drag.y });
      }
      groupDrags.current.clear();
      dispatch({ type: "move", moves: [...moves.values()] });
    },
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
        onNodeDragStart={onNodeDragStart}
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

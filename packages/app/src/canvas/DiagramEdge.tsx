import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, type EdgeTypes } from "@xyflow/react";
import type { FlowEdge } from "./toFlow";

const PRESET_STROKE: Record<string, string> = {
  "1": "var(--cat-warning-stroke)",
  "2": "var(--cat-entity-stroke)",
  "3": "var(--cat-data-stroke)",
  "4": "var(--cat-service-stroke)",
  "5": "var(--cat-db-stroke)",
  "6": "var(--cat-layer-stroke)",
};

const DiagramEdgeView = memo(function DiagramEdgeView(props: EdgeProps<FlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  if (!data) return null;
  const { edge, state } = data;
  const stroke = edge.color ? (PRESET_STROKE[edge.color] ?? edge.color) : undefined;
  const cls = ["cm-edge", edge.style === "dashed" && "cm-dashed", state && `cm-edge-${state}`, selected && "cm-edge-selected"]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={cls}
        style={stroke ? { stroke } : undefined}
        markerEnd={edge.toEnd === "none" ? undefined : state === "active" ? "url(#cm-arrow-active)" : "url(#cm-arrow)"}
        markerStart={edge.fromEnd === "arrow" ? "url(#cm-arrow-start)" : undefined}
        interactionWidth={16}
      />
      {edge.label && (
        <EdgeLabelRenderer>
          <div
            className={`cm-edge-label ${state ? `cm-edge-label-${state}` : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={edge.label}
          >
            {edge.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes: EdgeTypes = { diagram: DiagramEdgeView };

/** Arrowheads styled by CSS (SVG fill attributes can't read CSS variables). Must live inside the captured canvas for image export. */
export function EdgeMarkers() {
  return (
    <svg className="cm-markers" aria-hidden="true">
      <defs>
        <marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,1 L9,5 L0,9 z" />
        </marker>
        <marker id="cm-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,1 L9,5 L0,9 z" />
        </marker>
        <marker id="cm-arrow-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" />
        </marker>
      </defs>
    </svg>
  );
}

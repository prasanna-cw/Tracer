import { createContext, memo, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { DiagramNode, Side } from "@tracer/core";
import { Markdown } from "./Markdown";
import { paletteOf, plainText, type FlowNode } from "./toFlow";

/** Stable callbacks for node components; passing them via context keeps node props (and memo) stable. */
export const CanvasActions = createContext<{ editText(id: string, text: string): void; editable: boolean }>({
  editText: () => undefined,
  editable: false,
});

const SIDES: [Side, Position][] = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
];

// Invisible anchors so edges honor fromSide/toSide. Connecting by drag is not a feature yet.
const Handles = memo(function Handles() {
  return (
    <>
      {SIDES.map(([side, pos]) => (
        <span key={side}>
          <Handle type="source" id={`s-${side}`} position={pos} isConnectable={false} className="cm-handle" />
          <Handle type="target" id={`t-${side}`} position={pos} isConnectable={false} className="cm-handle" />
        </span>
      ))}
    </>
  );
});

function paletteStyle(n: DiagramNode): { className: string; style?: CSSProperties } {
  const p = paletteOf(n);
  if (!p.hex) return { className: `cat-${p.family}` };
  return {
    className: "cat-plain",
    style: {
      "--c-stroke": p.hex,
      "--c-fill": `color-mix(in srgb, ${p.hex} 14%, var(--surface))`,
      "--c-text": `color-mix(in srgb, ${p.hex} 55%, var(--text))`,
    } as CSSProperties,
  };
}

function Frame({ node, variant, children }: { node: DiagramNode; variant: string; children: ReactNode }) {
  const { className, style } = paletteStyle(node);
  return (
    <div className={`cm-node cm-${variant} ${className}`} style={style} title={plainText(node)}>
      <Handles />
      {children}
    </div>
  );
}

const Title = ({ children }: { children?: string }) => (children ? <div className="cm-title">{children}</div> : null);
const Subtitle = ({ children }: { children?: string }) => (children ? <div className="cm-subtitle">{children}</div> : null);

/** Markdown body; double-click edits it in place (Ctrl+Enter or blur commits, Esc cancels). */
function EditableText({ node }: { node: DiagramNode }) {
  const { editText, editable } = useContext(CanvasActions);
  const [draft, setDraft] = useState<string | null>(null);
  const canEdit = editable && node.type === "text";

  if (draft !== null) {
    const commit = () => {
      editText(node.id, draft);
      setDraft(null);
    };
    return (
      <textarea
        className="cm-editor nodrag nowheel nopan"
        aria-label="Edit node text"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep canvas shortcuts (Delete, arrows, Ctrl+Z) out of the editor
          if (e.key === "Escape") setDraft(null);
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
        }}
      />
    );
  }
  return (
    // Keyboard users edit the same field from the side panel.
    <div className="cm-body" onDoubleClick={canEdit ? () => setDraft(node.text ?? "") : undefined}>
      {node.text ? <Markdown text={node.text} /> : canEdit && !node.title && !node.rows?.length ? <span className="cm-placeholder">Double-click to add text</span> : null}
    </div>
  );
}

function Rows({ node }: { node: DiagramNode }) {
  if (!node.rows?.length) return null;
  return (
    <ul className="cm-rows">
      {node.rows.map((r, i) => (
        <li key={i} className={r.muted ? "cm-muted" : undefined}>
          {r.text}
        </li>
      ))}
    </ul>
  );
}

type P = NodeProps<FlowNode>;

/** A branch or loop header of a generated flow: `subtitle` is the keyword (if, loop, switch, try, catch). */
const DecisionNode = memo(function DecisionNode({ data }: P) {
  return (
    <Frame node={data} variant="decision">
      <div className="cm-kicker">{data.subtitle}</div>
      <div className="cm-title">{data.title}</div>
    </Frame>
  );
});

/** A return or throw: the flow stops here. */
const EndNode = memo(function EndNode({ data }: P) {
  return (
    <Frame node={data} variant="end">
      <div className="cm-kicker">{data.subtitle}</div>
      <div className="cm-title">{data.title}</div>
      <Rows node={data} />
    </Frame>
  );
});

const StartNode = memo(function StartNode({ data }: P) {
  return (
    <Frame node={data} variant="start">
      <div className="cm-title">{data.title ?? data.text ?? "Start"}</div>
      {data.subtitle && <div className="cm-subtitle">{data.subtitle}</div>}
    </Frame>
  );
});

const LayerNode = memo(function LayerNode({ data }: P) {
  return (
    <Frame node={data} variant="layer">
      <Title>{data.title}</Title>
      <Subtitle>{data.subtitle}</Subtitle>
      <EditableText node={data} />
      <Rows node={data} />
    </Frame>
  );
});

const EntityNode = memo(function EntityNode({ data }: P) {
  return (
    <Frame node={data} variant="entity">
      <Title>{data.title}</Title>
      <Subtitle>{data.subtitle}</Subtitle>
      <EditableText node={data} />
    </Frame>
  );
});

const NoteNode = memo(function NoteNode({ data }: P) {
  return (
    <Frame node={data} variant="note">
      <Title>{data.title}</Title>
      <EditableText node={data} />
      <Rows node={data} />
    </Frame>
  );
});

const TextNode = memo(function TextNode({ data }: P) {
  return (
    <Frame node={data} variant="text">
      <Title>{data.title}</Title>
      <Subtitle>{data.subtitle}</Subtitle>
      <EditableText node={data} />
      <Rows node={data} />
    </Frame>
  );
});

/** Rows split on " | " into cells; a muted first row is the header. */
const TableNode = memo(function TableNode({ data }: P) {
  const rows = (data.rows ?? []).map((r) => ({ cells: r.text.split(" | "), muted: r.muted }));
  const [head, ...body] = rows;
  const header = head?.muted ? head : undefined;
  const cols = Math.max(1, ...rows.map((r) => r.cells.length));
  const cellRow = (cells: string[], Cell: "th" | "td") =>
    Array.from({ length: cols }, (_, i) => (
      <Cell key={i} title={cells[i]}>
        {cells[i] ?? ""}
      </Cell>
    ));
  return (
    <Frame node={data} variant="table">
      <Title>{data.title}</Title>
      {data.text && <EditableText node={data} />}
      <div className="cm-table-wrap">
        <table>
          {header && (
            <thead>
              <tr>{cellRow(header.cells, "th")}</tr>
            </thead>
          )}
          <tbody>
            {(header ? body : rows).map((r, i) => (
              <tr key={i}>{cellRow(r.cells, "td")}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
});

const FileNode = memo(function FileNode({ data }: P) {
  return (
    <Frame node={data} variant="file">
      <div className="cm-kicker">File</div>
      <div className="cm-title cm-mono">{data.file}</div>
      {data.subpath && <Subtitle>{data.subpath}</Subtitle>}
    </Frame>
  );
});

const LinkNode = memo(function LinkNode({ data }: P) {
  return (
    <Frame node={data} variant="link">
      <div className="cm-kicker">Link</div>
      <a className="cm-title nodrag" href={data.url} target="_blank" rel="noreferrer noopener">
        {data.url}
      </a>
    </Frame>
  );
});

const GroupNode = memo(function GroupNode({ data }: P) {
  const { className, style } = paletteStyle(data);
  return (
    <div className={`cm-group ${data.color || data.category ? className : ""}`} style={style} title={data.label}>
      <Handles />
      {data.label && <div className="cm-group-label">{data.label}</div>}
    </div>
  );
});

export const nodeTypes: NodeTypes = {
  start: StartNode,
  decision: DecisionNode,
  end: EndNode,
  layer: LayerNode,
  entity: EntityNode,
  data: TableNode,
  table: TableNode,
  note: NoteNode,
  text: TextNode,
  file: FileNode,
  link: LinkNode,
  cmgroup: GroupNode,
};

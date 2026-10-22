import type { DiagramNode } from "@codemap/core";
import { Markdown } from "../canvas/Markdown";

type Props = {
  node: DiagramNode;
  editable: boolean;
  onEditText: (text: string) => void;
  onOpenSource: (path: string, line?: number) => void;
  onClose: () => void;
};

export function SidePanel({ node, editable, onEditText, onOpenSource, onClose }: Props) {
  const heading = node.title ?? node.label ?? node.file ?? node.url ?? node.id;
  const source = node.source;
  return (
    <aside className="side-panel" aria-label="Node details">
      <header>
        <div className="chips">
          <span className="chip">{node.kind ?? node.type}</span>
          {node.category && <span className="chip">{node.category}</span>}
        </div>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </header>
      <h2>{heading}</h2>
      {node.subtitle && <p className="mono muted">{node.subtitle}</p>}

      {node.type === "text" &&
        (editable ? (
          <label className="field">
            <span>Text (markdown)</span>
            {/* Uncontrolled + keyed: resets when the node or its text changes elsewhere (undo, canvas edit). */}
            <textarea
              key={`${node.id}:${node.text ?? ""}`}
              defaultValue={node.text ?? ""}
              rows={6}
              onBlur={(e) => e.target.value !== (node.text ?? "") && onEditText(e.target.value)}
            />
          </label>
        ) : (
          node.text && (
            <div className="md">
              <Markdown text={node.text} />
            </div>
          )
        ))}

      {node.rows?.length ? (
        <ul className="rows">
          {node.rows.map((r, i) => (
            <li key={i} className={r.muted ? "muted" : undefined}>
              {r.text}
            </li>
          ))}
        </ul>
      ) : null}

      {source && (
        <div className="source">
          <span className="mono">
            {source.path}
            {source.line ? `:${source.line}` : ""}
          </span>
          <button type="button" onClick={() => onOpenSource(source.path, source.line)}>
            Open source
          </button>
        </div>
      )}
    </aside>
  );
}

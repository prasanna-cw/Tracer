import { IconButton, TracerMark } from "./Icon";
import { MenuButton, type MenuItem } from "./Menu";

export type Theme = "light" | "dark";
export type SaveState = "idle" | "saving" | "saved";
export type View = "diagram" | "map" | "graph" | "galaxy";

const VIEW_LABEL: Record<View, string> = { diagram: "Flow", map: "Map", graph: "Graph", galaxy: "Galaxy" };

/** The segmented switch between the app's views. */
export function ViewTabs({ view, views, onView }: { view: View; views: readonly View[]; onView: (v: View) => void }) {
  return (
    <div className="segmented" role="tablist" aria-label="View">
      {views.map((v) => (
        <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => onView(v)}>
          {VIEW_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

type Props = {
  /** web: brand, Flow/Graph switch, file picker, theme toggle. editor (VS Code): one document; theme follows VS Code. */
  mode: "web" | "editor";
  view: View;
  onView: (v: View) => void;
  diagrams: { id: string; title: string }[];
  currentId: string | null;
  onOpen: (id: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  dirty: boolean;
  saveState: SaveState;
  onSave: () => void;
  onExport: (kind: "canvas" | "svg" | "png") => void;
  hasSteps: boolean;
  walkthrough: boolean;
  onToggleWalkthrough: () => void;
  snap: boolean;
  onToggleSnap: () => void;
  minimap: boolean;
  onToggleMinimap: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
};

export function Toolbar(p: Props) {
  const web = p.mode === "web";
  const more: MenuItem[] = [
    { kind: "heading", label: "View" },
    { kind: "check", label: "Snap to grid", checked: p.snap, onSelect: p.onToggleSnap },
    { kind: "check", label: "Minimap", checked: p.minimap, onSelect: p.onToggleMinimap },
    { kind: "separator" },
    { kind: "heading", label: "Export" },
    { kind: "action", label: "Image (PNG)", icon: "file-media", onSelect: () => p.onExport("png") },
    { kind: "action", label: "Vector (SVG)", icon: "file-code", onSelect: () => p.onExport("svg") },
    { kind: "action", label: "JSON Canvas (.canvas)", icon: "json", onSelect: () => p.onExport("canvas") },
  ];
  return (
    <header className="toolbar" role="toolbar" aria-label="Tracer">
      {web && (
        <>
          <span className="brand">
            <TracerMark />
            Tracer
          </span>
          <ViewTabs view={p.view} views={["diagram", "map", "graph", "galaxy"]} onView={p.onView} />
        </>
      )}
      {web && p.view === "diagram" && (
        <select className="picker" aria-label="Diagram" value={p.currentId ?? ""} onChange={(e) => p.onOpen(e.target.value)}>
          {p.diagrams.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      )}

      <span className="tb-spacer" />

      {p.view === "diagram" && (
        <>
          <div className="tb-group">
            <IconButton icon="discard" label="Undo (Ctrl+Z)" onClick={p.onUndo} disabled={!p.canUndo} />
            <IconButton icon="redo" label="Redo (Ctrl+Shift+Z)" onClick={p.onRedo} disabled={!p.canRedo} />
            <IconButton
              icon="save"
              label={p.dirty ? "Save (Ctrl+S) · unsaved changes" : "Save (Ctrl+S)"}
              badge={p.dirty}
              onClick={p.onSave}
              disabled={p.saveState === "saving"}
            />
            <span className="save-status" aria-live="polite">
              {p.saveState === "saving" ? "Saving…" : p.saveState === "saved" ? "Saved" : ""}
            </span>
          </div>
          <span className="tb-divider" />
          <button
            type="button"
            className="text-btn"
            aria-pressed={p.walkthrough}
            onClick={p.onToggleWalkthrough}
            disabled={!p.hasSteps}
            title={p.hasSteps ? "Step through the flow (←/→, Esc)" : "This diagram has no walkthrough steps"}
          >
            <span className={`codicon codicon-${p.walkthrough ? "debug-stop" : "play"}`} aria-hidden="true" />
            Walkthrough
          </button>
          <MenuButton icon="ellipsis" label="More" items={more} />
        </>
      )}

      {web && (
        <IconButton
          icon="color-mode"
          label={`Switch to ${p.theme === "light" ? "dark" : "light"} theme`}
          onClick={() => p.onTheme(p.theme === "light" ? "dark" : "light")}
        />
      )}
    </header>
  );
}

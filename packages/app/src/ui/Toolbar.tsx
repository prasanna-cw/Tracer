export type Theme = "clean" | "obsidian";
export type SaveState = "idle" | "saving" | "saved";

type Props = {
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
  return (
    <header className="toolbar" role="toolbar" aria-label="Diagram">
      <strong className="brand">CodeMap</strong>
      <select aria-label="Diagram" value={p.currentId ?? ""} onChange={(e) => p.onOpen(e.target.value)}>
        {p.diagrams.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </select>

      <div className="group">
        <button type="button" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
        <button type="button" onClick={p.onSave} title="Save (Ctrl+S)" disabled={p.saveState === "saving"}>
          {p.dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
          Save
        </button>
        <span className="save-status" aria-live="polite">
          {p.saveState === "saving" ? "Saving…" : p.saveState === "saved" ? "Saved" : ""}
        </span>
      </div>

      <div className="group">
        <span className="muted">Export</span>
        <button type="button" onClick={() => p.onExport("canvas")} title="JSON Canvas for Obsidian">
          .canvas
        </button>
        <button type="button" onClick={() => p.onExport("svg")} title="SVG of the current view">
          SVG
        </button>
        <button type="button" onClick={() => p.onExport("png")} title="PNG of the current view">
          PNG
        </button>
      </div>

      <div className="group">
        <button type="button" aria-pressed={p.walkthrough} onClick={p.onToggleWalkthrough} disabled={!p.hasSteps}>
          Walkthrough
        </button>
        <button type="button" aria-pressed={p.snap} onClick={p.onToggleSnap}>
          Snap
        </button>
        <button type="button" aria-pressed={p.minimap} onClick={p.onToggleMinimap}>
          Minimap
        </button>
      </div>

      <div className="group theme-switch" role="radiogroup" aria-label="Theme">
        {(["clean", "obsidian"] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={p.theme === t} onClick={() => p.onTheme(t)}>
            {t === "clean" ? "Clean" : "Obsidian"}
          </button>
        ))}
      </div>
    </header>
  );
}

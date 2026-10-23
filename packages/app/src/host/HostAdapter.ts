import type { CodeGraph, Diagram, Params, ThemeName } from "@tracer/core";

/** Which UI the app shows. */
/** editor: a document the host owns (VS Code text editor); flow: a generated diagram held in memory, saved on request. */
export type HostEnv = { kind: "web" } | { kind: "editor"; documentId: string } | { kind: "flow"; documentId: string } | { kind: "graph" };

/**
 * Every bit of I/O the UI does. WebHost implements it for the browser prototype; VSCodeHost implements it
 * over webview postMessage. The UI never touches fetch/fs directly.
 */
export interface HostAdapter {
  loadDiagram(id: string): Promise<Diagram>;
  saveDiagram(id: string, diagram: Diagram): Promise<void>;
  loadGraph(): Promise<CodeGraph>;
  /** web: shows a toast; VS Code: opens the editor at the line. */
  openSource(path: string, line?: number): Promise<void>;
  listDiagrams(): Promise<{ id: string; title: string }[]>;
  /** Hands the user a generated file (.canvas, .svg, .png). web: download; VS Code: save dialog (webviews block downloads). */
  exportFile(filename: string, data: Blob | string): Promise<void>;

  // Optional: hosts that own the document (VS Code custom editor) and the theme.
  /** One committed change; the host applies it to its document (and owns undo/redo/dirty state). */
  applyEdit?(id: string, diagram: Diagram): void;
  runCommand?(name: "undo" | "redo"): void;
  /** The document changed outside the app (undo/redo, another editor, a save from Obsidian). Returns unsubscribe. */
  onDocumentChanged?(listener: (id: string, diagram: Diagram) => void): () => void;
  onDocumentInvalid?(listener: (id: string, errors: string[]) => void): () => void;
  /** `native`: use the host's own colors (VS Code theme) instead of Tracer's palette for the chrome. */
  onThemeChanged?(listener: (theme: ThemeName, native: boolean) => void): () => void;
  reportStatus?(status: Params<"reportStatus">): void;
}

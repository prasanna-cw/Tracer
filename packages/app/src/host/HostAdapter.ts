import type { CodeGraph, Diagram } from "@codemap/core";

/**
 * Every bit of I/O the UI does. WebHost implements it for the browser prototype; a VS Code
 * extension will implement it over webview postMessage. The UI never touches fetch/fs directly.
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
}

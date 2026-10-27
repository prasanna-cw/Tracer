import {
  parseResult,
  parseToWebview,
  type CodeGraph,
  type Diagram,
  type HostEvent,
  type Method,
  type Params,
  type Result,
  type ThemeName,
} from "@tracer/core";
import type { HostAdapter } from "./HostAdapter";

type VsCodeApi = { postMessage(message: unknown): void };
type Pending = { method: Method; resolve: (value: unknown) => void; reject: (error: Error) => void };

export const inVsCode = (): boolean => typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === "function";

/**
 * HostAdapter over the VS Code webview channel. Requests are matched to responses by id; every incoming
 * message (and every result) is validated with the protocol schemas before it reaches the UI.
 */
export class VSCodeHost implements HostAdapter {
  private readonly api: VsCodeApi;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: HostEvent) => void>();

  constructor() {
    this.api = (globalThis as unknown as { acquireVsCodeApi(): VsCodeApi }).acquireVsCodeApi();
    window.addEventListener("message", (ev: MessageEvent) => this.receive(ev.data));
  }

  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const id = this.nextId++;
    return new Promise<Result<M>>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.api.postMessage({ kind: "request", id, method, params });
    });
  }

  private receive(raw: unknown): void {
    const r = parseToWebview(raw);
    if (!r.ok) {
      console.error("[codemap] dropped an invalid message from the extension:", r.errors);
      return;
    }
    const m = r.value;
    if (m.kind === "event") {
      for (const listener of this.listeners) listener(m);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (!m.ok) {
      p.reject(new Error(m.error));
      return;
    }
    const result = parseResult(p.method, m.result ?? null);
    if (result.ok) p.resolve(result.value);
    else p.reject(new Error(`invalid ${p.method} result: ${result.errors.join("; ")}`));
  }

  private on(listener: (e: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  loadDiagram(id: string): Promise<Diagram> {
    return this.call("loadDiagram", { id });
  }
  async saveDiagram(id: string, diagram: Diagram): Promise<void> {
    await this.call("saveDiagram", { id, diagram });
  }
  private graph?: Promise<CodeGraph>;
  /** The map and the graph both ask; the (large) graph crosses the webview boundary once. */
  loadGraph(): Promise<CodeGraph> {
    this.graph ??= this.call("loadGraph", {});
    return this.graph;
  }
  onGraphChanged(listener: (graph: CodeGraph) => void): () => void {
    return this.on((e) => {
      if (e.type !== "graphUpdated") return;
      this.graph = Promise.resolve(e.graph); // so a Map/Graph tab opened later starts from the latest, not a stale loadGraph
      listener(e.graph);
    });
  }
  async openSource(path: string, line?: number): Promise<void> {
    await this.call("openSource", line ? { path, line } : { path });
  }
  listDiagrams(): Promise<{ id: string; title: string }[]> {
    return this.call("listDiagrams", {});
  }
  async exportFile(filename: string, data: Blob | string): Promise<void> {
    if (typeof data === "string") {
      await this.call("exportFile", { filename, data, encoding: "utf8" });
      return;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await this.call("exportFile", { filename, data: btoa(binary), encoding: "base64" });
  }

  applyEdit(id: string, diagram: Diagram): void {
    this.call("applyEdit", { id, diagram }).catch((e: unknown) => console.error("[codemap] edit was not applied:", e));
  }
  runCommand(name: "undo" | "redo"): void {
    void this.call("runCommand", { name });
  }
  onDocumentChanged(listener: (id: string, diagram: Diagram) => void): () => void {
    return this.on((e) => e.type === "documentChanged" && listener(e.id, e.diagram));
  }
  onDocumentInvalid(listener: (id: string, errors: string[]) => void): () => void {
    return this.on((e) => e.type === "documentInvalid" && listener(e.id, e.errors));
  }
  onThemeChanged(listener: (theme: ThemeName, native: boolean) => void): () => void {
    return this.on((e) => e.type === "theme" && listener(e.theme, e.native));
  }
  reportStatus(status: Params<"reportStatus">): void {
    this.call("reportStatus", status).catch(() => undefined);
  }
}

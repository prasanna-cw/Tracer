import {
  codeGraphSchema,
  diagramToText,
  findUnknownKeys,
  formatIssues,
  isCanvasFile as isCanvas,
  textToDiagram,
  type CodeGraph,
  type Diagram,
} from "@tracer/core";
import type { HostAdapter } from "./HostAdapter";

// Samples are bundled at build time (and hot-reloaded in dev), so the prototype needs no server.
const SAMPLES = import.meta.glob<string>(["../../../../samples/*.diagram.json", "../../../../samples/*.canvas"], { query: "?raw", import: "default" });
const sampleId = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const loaders = new Map(Object.entries(SAMPLES).map(([path, load]) => [sampleId(path), load]));

// Chromium's File System Access API; absent from TS's DOM lib and from Firefox/Safari.
type SaveHandle = { createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> };
type SavePicker = (opts: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<SaveHandle>;

export class WebHost implements HostAdapter {
  private readonly handles = new Map<string, SaveHandle>();

  constructor(private readonly notify: (message: string) => void) {}

  async listDiagrams(): Promise<{ id: string; title: string }[]> {
    return [...loaders.keys()].sort().map((id) => ({ id, title: id.replace(/\.(diagram\.json|json|canvas)$/i, "") }));
  }

  async loadDiagram(id: string): Promise<Diagram> {
    const load = loaders.get(id);
    if (!load) throw new Error(`No diagram named "${id}" in samples/`);
    const r = textToDiagram(id, await load());
    if (!r.ok) throw new Error(`${id} is not a valid ${isCanvas(id) ? "JSON Canvas" : "diagram"}:\n${r.errors.join("\n")}`);
    for (const w of r.warnings) this.notify(w);
    // Dev-only: unknown keys are preserved, so a typo or an invented field would otherwise go unnoticed.
    const unknown = findUnknownKeys(r.value);
    if (import.meta.env.DEV && unknown.length) {
      console.warn(`[codemap] ${id}: keys outside the schema (kept as-is): ${unknown.join(", ")}`);
    }
    return r.value;
  }

  /** Saves in the file's own format. Chromium: real file handle (remembered per diagram); elsewhere: a download. */
  async saveDiagram(id: string, diagram: Diagram): Promise<void> {
    const text = diagramToText(id, diagram);
    const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (!picker) {
      download(id, text, "application/json");
      return;
    }
    let handle = this.handles.get(id);
    if (!handle) {
      const ext = isCanvas(id) ? ".canvas" : ".json";
      handle = await picker({ suggestedName: id, types: [{ description: "Diagram", accept: { "application/json": [ext] } }] });
      this.handles.set(id, handle);
    }
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  }

  private graph: Promise<CodeGraph> | undefined;

  /** packages/app/public/graph.json (from `npm run analyze`) if present, else the committed demo graph. Loaded once per page. */
  loadGraph(): Promise<CodeGraph> {
    this.graph ??= this.fetchGraph();
    this.graph.catch(() => (this.graph = undefined)); // a failed load can be retried
    return this.graph;
  }

  private async fetchGraph(): Promise<CodeGraph> {
    const res = await fetch("/graph.json").catch(() => undefined);
    // Vite's dev server answers unknown paths with index.html (200), so check the content type, not just the status.
    if (res?.ok && res.headers.get("content-type")?.includes("json")) {
      const r = codeGraphSchema.safeParse(await res.json());
      if (!r.success) throw new Error(`graph.json is not a CodeMap graph:\n${formatIssues(r.error).join("\n")}`);
      return r.data;
    }
    this.notify("Showing the demo graph (samples/demo-repo). Analyze your own repo: npm run analyze -- --root <path> --out packages/app/public/graph.json");
    const demo: unknown = (await import("../../../../samples/demo-graph.json")).default;
    return codeGraphSchema.parse(demo);
  }

  async openSource(path: string, line?: number): Promise<void> {
    this.notify(`Open source: ${path}${line ? `:${line}` : ""} (opens in the editor once this runs inside VS Code)`);
  }

  async exportFile(filename: string, data: Blob | string): Promise<void> {
    download(filename, data);
  }
}

function download(filename: string, data: string | Blob, type = "application/json"): void {
  const url = URL.createObjectURL(typeof data === "string" ? new Blob([data], { type }) : data);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

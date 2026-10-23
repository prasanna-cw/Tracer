// Runs workspace analysis off the extension host's main thread (a large workspace takes seconds and would
// freeze every other extension). Bundled separately as dist/analyzerWorker.js; grammars come from dist/grammars.
import { parentPort, workerData } from "node:worker_threads";
import { analyzeWorkspace, indexWorkspace } from "@tracer/cli/workspace";

export type WorkerMessage =
  | { kind: "progress"; phase: string; done: number; total: number }
  | { kind: "done"; ok: true; graph: unknown; ms: number; parseMs: number }
  | { kind: "indexed"; ok: true; files: unknown[]; ms: number }
  | { kind: "done" | "indexed"; ok: false; error: string };

const { mode, root, wasmDir } = workerData as { mode: "graph" | "index"; root: string; wasmDir: string };
const post = (m: WorkerMessage) => parentPort?.postMessage(m);
const started = Date.now();
const onProgress = (p: { phase: string; done: number; total: number }) => post({ kind: "progress", ...p });
const fail = (kind: "done" | "indexed") => (e: unknown) => post({ kind, ok: false, error: e instanceof Error ? e.message : String(e) });

if (mode === "index") {
  indexWorkspace(root, { wasmDir, onProgress }).then((files) => post({ kind: "indexed", ok: true, files, ms: Date.now() - started }), fail("indexed"));
} else {
  analyzeWorkspace(root, { wasmDir, onProgress }).then(
    ({ graph, parseMs }) => post({ kind: "done", ok: true, graph, ms: Date.now() - started, parseMs }),
    fail("done"),
  );
}

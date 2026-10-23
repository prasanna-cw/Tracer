// Runs the analysis off the extension host's main thread (a large workspace takes seconds and would freeze
// every other extension). Bundled separately as dist/analyzerWorker.js; grammars come from dist/grammars.
import { parentPort, workerData } from "node:worker_threads";
import { analyzeWorkspace } from "@tracer/cli/workspace";

export type WorkerMessage =
  | { kind: "progress"; phase: string; done: number; total: number }
  | { kind: "done"; ok: true; graph: unknown; ms: number; parseMs: number }
  | { kind: "done"; ok: false; error: string };

const { root, wasmDir } = workerData as { root: string; wasmDir: string };
const post = (m: WorkerMessage) => parentPort?.postMessage(m);
const started = Date.now();
analyzeWorkspace(root, { wasmDir, onProgress: (p) => post({ kind: "progress", ...p }) }).then(
  ({ graph, parseMs }) => post({ kind: "done", ok: true, graph, ms: Date.now() - started, parseMs }),
  (e: unknown) => post({ kind: "done", ok: false, error: e instanceof Error ? e.message : String(e) }),
);

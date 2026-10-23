// Runs the analyzer off the extension host's main thread (a large repo takes seconds and would freeze
// every other extension). Bundled separately as dist/analyzerWorker.js.
import { parentPort, workerData } from "node:worker_threads";
import { analyzeRepo } from "@tracer/core/analyzer";
import { nodeFileSystem } from "@tracer/cli/nodeFileSystem";

const { root } = workerData as { root: string };
const started = Date.now();
try {
  const { graph } = analyzeRepo(nodeFileSystem, root);
  parentPort?.postMessage({ ok: true, graph, ms: Date.now() - started });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}

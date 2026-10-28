import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { applyCoverage, codeGraphSchema, type CodeGraph, type CodeGraphSummary, type FileCoverage } from "@tracer/core";
import type { WorkerMessage } from "./analyzerWorker";
import { Coalesced } from "./coalesce";
import type { Status } from "./diagramEditor";
import { IGNORED, SOURCE_GLOB } from "./flowService";
import { serve } from "./rpc";
import { currentTheme, onThemeChange } from "./theme";
import { webviewHtml, webviewOptions } from "./webview";
import { exportFile, listDiagrams, openSource } from "./workspace";

const noopProgress: vscode.Progress<{ message?: string; increment?: number }> = { report: () => undefined };

type OpenPanel = { folderName: string; get: () => CodeGraph; set: (g: CodeGraph) => void };
/** Every currently open Map/Graph panel, keyed by its folder's URI string. Lets a separate command (loading
 * a coverage report) reach an already-open panel without either side needing a direct reference to the other. */
const openPanels = new Map<string, OpenPanel>();

/** Merges a loaded coverage report into every open Map/Graph panel and pushes the update live (same path a
 * file-change refresh uses). Returns per-panel match counts so the caller can tell the user what landed. */
export function applyCoverageToOpenPanels(coverage: readonly FileCoverage[]): { folderName: string; matched: number; unmatched: number }[] {
  return [...openPanels.values()].map((p) => {
    const r = applyCoverage(p.get(), coverage);
    p.set(r.graph);
    return { folderName: p.folderName, matched: r.matched, unmatched: r.unmatched };
  });
}

type Reply = WorkerMessage;

/** Runs the analysis in a worker thread; progress messages drive the notification. */
function analyze(
  extensionUri: vscode.Uri,
  root: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<{ graph: CodeGraph; ms: number; parseMs: number }> {
  return new Promise((resolve, reject) => {
    const dist = vscode.Uri.joinPath(extensionUri, "dist");
    const worker = new Worker(vscode.Uri.joinPath(dist, "analyzerWorker.js").fsPath, {
      workerData: { mode: "graph", root, wasmDir: vscode.Uri.joinPath(dist, "grammars").fsPath },
    });
    const cancel = token.onCancellationRequested(() => {
      void worker.terminate();
      reject(new vscode.CancellationError());
    });
    let reported = 0;
    worker.on("message", (m: Reply) => {
      if (m.kind === "progress") {
        if (m.phase === "parsing" && m.total) {
          const pct = Math.floor((m.done / m.total) * 90);
          progress.report({ message: `parsing ${m.done.toLocaleString()} / ${m.total.toLocaleString()} files`, increment: pct - reported });
          reported = pct;
        } else if (m.phase === "linking") progress.report({ message: "linking imports…" });
        return;
      }
      if (m.kind !== "done") return; // "indexed" belongs to the flow index worker
      cancel.dispose();
      void worker.terminate();
      if (m.ok) resolve({ graph: codeGraphSchema.parse(m.graph), ms: m.ms, parseMs: m.parseMs });
      else reject(new Error(m.error));
    });
    worker.once("error", (e) => {
      cancel.dispose();
      reject(e);
    });
  });
}

/**
 * "Tracer: Open Graph": analyzes `target` (a folder from the explorer menu) or the first workspace folder
 * in a worker thread (with progress), reports warnings, and shows the graph. Resolves to the summary (used by
 * tests), or undefined if there was nothing to analyze or the user cancelled.
 *
 * `statuses` (keyed by the analyzed folder's URI string, like the flow/diagram editors' own status map) gets
 * `nodeCount` set after the initial analysis and again after every live refresh; integration tests use it to
 * observe a background refresh without a handle to the webview itself.
 */
export async function openGraphView(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  statuses: Map<string, Status>,
  target?: vscode.Uri,
  view: "map" | "graph" = "graph",
): Promise<CodeGraphSummary | undefined> {
  const first = vscode.workspace.workspaceFolders?.[0];
  const folder = target ? { uri: target, name: target.path.slice(target.path.lastIndexOf("/") + 1) } : first;
  if (!folder) {
    void vscode.window.showErrorMessage("Tracer: open a folder first. The graph is built from the first workspace folder.");
    return undefined;
  }
  if (folder.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("Tracer: the graph view needs a folder on the local disk.");
    return undefined;
  }

  let result: { graph: CodeGraph; ms: number; parseMs: number };
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Tracer: analyzing ${folder.name}…`, cancellable: true },
      // Forward slashes, as the analyzer expects. (Not toPosix from @tracer/core/analyzer: importing that
      // entry would pull the TypeScript compiler into extension.js; it belongs in the worker bundle only.)
      (progress, token) => analyze(context.extensionUri, folder.uri.fsPath.split("\\").join("/"), progress, token),
    );
  } catch (e) {
    if (e instanceof vscode.CancellationError) return undefined;
    void vscode.window.showErrorMessage(`Tracer: analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }

  let graph = result.graph;
  const { ms } = result;
  const s = graph.summary;
  const statusId = folder.uri.toString();
  statuses.set(statusId, { id: statusId, state: "loaded", nodeCount: graph.nodes.length });
  output.appendLine(
    `[graph] ${folder.name}: ${s.fileCount} files (+${s.skippedCount} skipped), ${s.edgeCount} imports, ` +
      `${s.unresolvedCount} unresolved, ${s.externalCount} external, ${s.assetCount} assets, ${s.cycleCount} cycles, ${ms} ms`,
  );
  for (const u of s.unresolved) output.appendLine(`  unresolved: ${u.from} -> ${u.specifier}`);
  for (const w of s.warnings) output.appendLine(`  warning: ${w}`);
  if (s.warnings.length) {
    void vscode.window
      .showWarningMessage(`Tracer: ${s.warnings.length} warning(s) while analyzing ${folder.name}.`, "Show details")
      .then((choice) => choice && output.show(true));
  }

  const panel = vscode.window.createWebviewPanel("tracer.graph", `${view === "map" ? "Map" : "Graph"}: ${folder.name}`, vscode.ViewColumn.Active, {
    ...webviewOptions(context.extensionUri),
    retainContextWhenHidden: true, // keeps the layout when the tab is in the background
  });
  panel.webview.html = await webviewHtml(panel.webview, context.extensionUri);

  const notInGraph = async (): Promise<never> => {
    throw new Error("not available in the graph view");
  };
  const server = serve(
    panel.webview,
    {
      init: async () => ({ mode: "graph", view, ...currentTheme() }),
      loadGraph: async () => graph,
      openSource: async ({ path, line }) => openSource([folder.uri], path, line),
      exportFile: async (p) => exportFile(p, folder.uri),
      listDiagrams,
      reportStatus: async () => null,
      loadDiagram: notInGraph,
      saveDiagram: notInGraph,
      applyEdit: notInGraph,
      runCommand: notInGraph,
    },
    (m) => output.appendLine(`[graph] ${m}`),
  );
  const theme = onThemeChange((t) => server.emit({ kind: "event", type: "theme", ...t }));

  const setGraph = (g: CodeGraph) => {
    graph = g;
    server.emit({ kind: "event", type: "graphUpdated", graph });
    statuses.set(statusId, { id: statusId, state: "loaded", nodeCount: graph.nodes.length });
  };
  openPanels.set(statusId, { folderName: folder.name, get: () => graph, set: setGraph });

  // Live refresh: a source file changing under `folder` re-analyzes in the background (fast, thanks to the
  // on-disk cache; see @tracer/cli/workspace) and pushes the new graph, so the panel does not go stale until
  // the user remembers to reopen it. Quiet (status-bar) progress, not a notification: this can fire on every save.
  const refreshCts = new vscode.CancellationTokenSource();
  const refresh = new Coalesced(500, () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Tracer: refreshing ${folder.name}…` }, async () => {
      try {
        const r = await analyze(context.extensionUri, folder.uri.fsPath.split("\\").join("/"), noopProgress, refreshCts.token);
        setGraph(r.graph);
        output.appendLine(`[graph] ${folder.name}: refreshed (${graph.summary.fileCount} files, ${graph.summary.edgeCount} imports)`);
      } catch (e) {
        if (!(e instanceof vscode.CancellationError)) output.appendLine(`[graph] refresh of ${folder.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder.uri, SOURCE_GLOB));
  const touch = (uri: vscode.Uri) => !IGNORED.test(vscode.workspace.asRelativePath(uri, false)) && refresh.trigger();
  const watcherSubs = [watcher, watcher.onDidChange(touch), watcher.onDidCreate(touch), watcher.onDidDelete(touch)];

  panel.onDidDispose(() => {
    server.dispose();
    theme.dispose();
    refresh.dispose();
    refreshCts.cancel();
    refreshCts.dispose();
    for (const d of watcherSubs) d.dispose();
    statuses.delete(statusId);
    openPanels.delete(statusId);
  });
  return s;
}

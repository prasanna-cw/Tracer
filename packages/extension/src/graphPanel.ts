import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { codeGraphSchema, type CodeGraph, type CodeGraphSummary } from "@tracer/core";
import type { WorkerMessage } from "./analyzerWorker";
import { serve } from "./rpc";
import { currentTheme, onThemeChange } from "./theme";
import { webviewHtml, webviewOptions } from "./webview";
import { exportFile, listDiagrams, openSource } from "./workspace";

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
 */
export async function openGraphView(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
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

  const { graph, ms } = result;
  const s = graph.summary;
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
  panel.onDidDispose(() => {
    server.dispose();
    theme.dispose();
  });
  return s;
}

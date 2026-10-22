import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import type { CodeGraph, CodeGraphSummary } from "@codemap/core";
import { serve } from "./rpc";
import { currentTheme, onThemeChange } from "./theme";
import { webviewHtml, webviewOptions } from "./webview";
import { exportFile, listDiagrams, openSource } from "./workspace";

type WorkerReply = { ok: true; graph: CodeGraph; ms: number } | { ok: false; error: string };

function analyze(extensionUri: vscode.Uri, root: string, token: vscode.CancellationToken): Promise<{ graph: CodeGraph; ms: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(vscode.Uri.joinPath(extensionUri, "dist", "analyzerWorker.js").fsPath, { workerData: { root } });
    const cancel = token.onCancellationRequested(() => {
      void worker.terminate();
      reject(new vscode.CancellationError());
    });
    worker.once("message", (reply: WorkerReply) => {
      cancel.dispose();
      void worker.terminate();
      if (reply.ok) resolve(reply);
      else reject(new Error(reply.error));
    });
    worker.once("error", (e) => {
      cancel.dispose();
      reject(e);
    });
  });
}

/**
 * "CodeMap: Open Graph View": analyzes the first workspace folder in a worker thread (with progress),
 * reports warnings, and shows the graph. Resolves to the summary (used by tests), or undefined if there
 * was nothing to analyze or the user cancelled.
 */
export async function openGraphView(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<CodeGraphSummary | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("CodeMap: open a folder first. The graph is built from the first workspace folder.");
    return undefined;
  }
  if (folder.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("CodeMap: the graph view needs a folder on the local disk.");
    return undefined;
  }

  let result: { graph: CodeGraph; ms: number };
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `CodeMap: analyzing ${folder.name}…`, cancellable: true },
      // Forward slashes, as the analyzer expects. (Not toPosix from @codemap/core/analyzer: importing that
      // entry would pull the TypeScript compiler into extension.js; it belongs in the worker bundle only.)
      (_progress, token) => analyze(context.extensionUri, folder.uri.fsPath.split("\\").join("/"), token),
    );
  } catch (e) {
    if (e instanceof vscode.CancellationError) return undefined;
    void vscode.window.showErrorMessage(`CodeMap: analysis failed: ${e instanceof Error ? e.message : String(e)}`);
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
      .showWarningMessage(`CodeMap: ${s.warnings.length} warning(s) while analyzing ${folder.name}.`, "Show details")
      .then((choice) => choice && output.show(true));
  }

  const panel = vscode.window.createWebviewPanel("codemap.graph", `Graph: ${folder.name}`, vscode.ViewColumn.Active, {
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
      init: async () => ({ mode: "graph", theme: currentTheme() }),
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
  const theme = onThemeChange((t) => server.emit({ kind: "event", type: "theme", theme: t }));
  panel.onDidDispose(() => {
    server.dispose();
    theme.dispose();
  });
  return s;
}

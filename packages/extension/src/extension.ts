import * as vscode from "vscode";
import { parseCoverage } from "@tracer/core";
import { newAdr, openAdrPicker } from "./adrCommands";
import { FlowEditorProvider, type Status } from "./diagramEditor";
import { applyCoverageToOpenPanels, openGraphView } from "./graphPanel";
import { FlowCommands } from "./flowCommands";
import { FlowPanel } from "./flowPanel";
import { FlowService } from "./flowService";
import { SidebarProvider } from "./sidebar";
import { findDiagrams } from "./workspace";

/**
 * Activated only by Tracer's commands and view, or by opening a *.diagram.json / *.canvas file (see activationEvents).
 * Nothing here talks to the network, and there is no telemetry.
 */
export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Tracer");
  const statuses = new Map<string, Status>();

  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(FlowEditorProvider.viewType, new FlowEditorProvider(context, output, statuses), {
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand("tracer.openGraph", (target?: unknown) =>
      openGraphView(context, output, statuses, target instanceof vscode.Uri ? target : undefined, "graph"),
    ),
    vscode.commands.registerCommand("tracer.openMap", (target?: unknown) =>
      openGraphView(context, output, statuses, target instanceof vscode.Uri ? target : undefined, "map"),
    ),
    vscode.commands.registerCommand("tracer.openDiagram", openDiagramPicker),
    vscode.commands.registerCommand("tracer.loadCoverage", loadCoveragePicker),
    vscode.commands.registerCommand("tracer.newAdr", newAdr),
    vscode.commands.registerCommand("tracer.openAdr", openAdrPicker),
  );

  // Show Flow: a diagram of a file, a function or a selection, beside the code.
  const flowService = new FlowService(context, output);
  const flows = new FlowCommands(flowService, new FlowPanel(context, output, statuses));
  context.subscriptions.push(
    flowService,
    vscode.commands.registerCommand("tracer.showFlow", (resource?: unknown) => flows.showFlow(resource)),
    vscode.commands.registerCommand("tracer.showFunctionFlow", () => flows.showFunctionFlow()),
    vscode.commands.registerCommand("tracer.traceCalls", () => flows.traceCalls()),
  );

  const sidebar = new SidebarProvider();
  const diagramFiles = vscode.workspace.createFileSystemWatcher("**/*.{diagram.json,canvas}", false, true, false);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("tracer.home", sidebar),
    vscode.commands.registerCommand("tracer.refresh", () => sidebar.refresh()),
    diagramFiles,
    diagramFiles.onDidCreate(() => sidebar.refresh()),
    diagramFiles.onDidDelete(() => sidebar.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sidebar.refresh()),
  );

  // Exported for the integration tests: whether an open editor's webview rendered its document.
  return { statusOf: (uri: string): Status | undefined => statuses.get(uri) };
}

async function openDiagramPicker(): Promise<void> {
  const files = await findDiagrams();
  if (!files.length) {
    void vscode.window.showInformationMessage("Tracer: no *.diagram.json or *.canvas files in this workspace.");
    return;
  }
  const items = files
    .map((uri) => {
      const relative = vscode.workspace.asRelativePath(uri);
      return { label: relative.slice(relative.lastIndexOf("/") + 1), description: relative, uri };
    })
    .sort((a, b) => a.description.localeCompare(b.description));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Open a saved flow in Tracer", matchOnDescription: true });
  if (pick) await vscode.commands.executeCommand("vscode.openWith", pick.uri, FlowEditorProvider.viewType);
}

/**
 * "Tracer: Load Coverage Report…": picks an lcov or Cobertura file (whatever your test runner already
 * produces) and merges it into every currently open Map/Graph panel, live.
 */
async function loadCoveragePicker(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: "Load Coverage Report",
    openLabel: "Load",
    filters: { "Coverage reports": ["info", "lcov", "xml"], "All files": ["*"] },
    canSelectMany: false,
  });
  const uri = picked?.[0];
  if (!uri) return;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  const files = parseCoverage(text);
  if (!files.length) {
    void vscode.window.showErrorMessage(`Tracer: "${vscode.workspace.asRelativePath(uri)}" doesn't look like an lcov or Cobertura coverage report.`);
    return;
  }
  const results = applyCoverageToOpenPanels(files);
  if (!results.length) {
    void vscode.window.showWarningMessage("Tracer: open Map or Graph first, then load the coverage report again.");
    return;
  }
  const summary = results.map((r) => `${r.folderName}: ${r.matched}/${r.matched + r.unmatched} files`).join("; ");
  void vscode.window.showInformationMessage(`Tracer: coverage loaded (${summary}).`);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

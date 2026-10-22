import * as vscode from "vscode";
import { DiagramEditorProvider, type Status } from "./diagramEditor";
import { openGraphView } from "./graphPanel";
import { findDiagrams } from "./workspace";

/**
 * Activated only by the two commands or by opening a *.diagram.json / *.canvas file (see activationEvents).
 * Nothing here talks to the network, and there is no telemetry.
 */
export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodeMap");
  const statuses = new Map<string, Status>();

  context.subscriptions.push(
    output,
    vscode.window.registerCustomEditorProvider(DiagramEditorProvider.viewType, new DiagramEditorProvider(context, output, statuses), {
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand("codemap.openGraph", () => openGraphView(context, output)),
    vscode.commands.registerCommand("codemap.openDiagram", openDiagramPicker),
  );

  // Exported for the integration tests: whether an open editor's webview rendered its document.
  return { statusOf: (uri: string): Status | undefined => statuses.get(uri) };
}

async function openDiagramPicker(): Promise<void> {
  const files = await findDiagrams();
  if (!files.length) {
    void vscode.window.showInformationMessage("CodeMap: no *.diagram.json or *.canvas files in this workspace.");
    return;
  }
  const items = files
    .map((uri) => {
      const relative = vscode.workspace.asRelativePath(uri);
      return { label: relative.slice(relative.lastIndexOf("/") + 1), description: relative, uri };
    })
    .sort((a, b) => a.description.localeCompare(b.description));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Open a diagram in CodeMap", matchOnDescription: true });
  if (pick) await vscode.commands.executeCommand("vscode.openWith", pick.uri, DiagramEditorProvider.viewType);
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

import * as vscode from "vscode";
import { diagramToText, textToDiagram, type Params } from "@codemap/core";
import { serve } from "./rpc";
import { currentTheme, onThemeChange } from "./theme";
import { webviewHtml, webviewOptions } from "./webview";
import { exportFile, listDiagrams, openSource, workspaceFolders } from "./workspace";

export type Status = Params<"reportStatus">;

/**
 * The diagram canvas as the editor for *.diagram.json and *.canvas. The TextDocument is the source of truth:
 * - every committed change in the webview becomes one WorkspaceEdit, so VS Code owns undo/redo, dirty and save;
 * - every change from elsewhere (undo, a text editor, a save from Obsidian on disk) is pushed to the webview.
 */
export class DiagramEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "codemap.diagramEditor";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly statuses: Map<string, Status>,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const id = document.uri.toString();
    const folder = vscode.Uri.joinPath(document.uri, "..");
    // The text the webview currently shows: changes equal to it are our own edits (or already shown).
    let shown = document.getText();

    panel.webview.options = webviewOptions(this.context.extensionUri);
    panel.webview.html = await webviewHtml(panel.webview, this.context.extensionUri);

    const write = async (text: string): Promise<void> => {
      if (text === document.getText()) return;
      shown = text;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code rejected the edit");
    };
    const assertId = (requested: string): void => {
      if (requested !== id) throw new Error("this editor only serves its own document");
    };

    const server = serve(
      panel.webview,
      {
        init: async () => ({ mode: "editor", documentId: id, theme: currentTheme() }),
        loadDiagram: async ({ id: requested }) => {
          assertId(requested);
          shown = document.getText();
          const r = textToDiagram(document.fileName, shown);
          if (!r.ok) throw new Error(r.errors.join("\n"));
          return r.value;
        },
        applyEdit: async ({ id: requested, diagram }) => {
          assertId(requested);
          await write(diagramToText(document.fileName, diagram));
          return null;
        },
        saveDiagram: async ({ id: requested, diagram }) => {
          assertId(requested);
          await write(diagramToText(document.fileName, diagram));
          await document.save();
          return null;
        },
        runCommand: async ({ name }) => {
          await vscode.commands.executeCommand(name);
          return null;
        },
        loadGraph: async () => {
          throw new Error('Open the graph with "CodeMap: Open Graph View".');
        },
        // Node sources are workspace-relative; diagrams outside a workspace resolve next to the file.
        openSource: async ({ path, line }) => openSource([...workspaceFolders(), folder], path, line),
        listDiagrams,
        exportFile: async (p) => exportFile(p, folder),
        reportStatus: async (status) => {
          this.statuses.set(id, status);
          if (status.state === "error") this.output.appendLine(`[editor] ${vscode.workspace.asRelativePath(document.uri)}: ${status.detail ?? "failed"}`);
          return null;
        },
      },
      (m) => this.output.appendLine(`[editor] ${m}`),
    );

    const push = (text: string): void => {
      if (text === shown) return;
      shown = text;
      const r = textToDiagram(document.fileName, text);
      server.emit(
        r.ok ? { kind: "event", type: "documentChanged", id, diagram: r.value } : { kind: "event", type: "documentInvalid", id, errors: r.errors },
      );
    };

    const subscriptions = [
      // Undo/redo, other editors, VS Code reloading the file from disk.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document && e.contentChanges.length) push(document.getText());
      }),
      // Explicit watcher for saves from outside (e.g. Obsidian). VS Code reloads clean documents by itself;
      // this makes the canvas follow immediately, and warns instead of overwriting unsaved edits.
      watchFile(document.uri, async () => {
        const disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
        if (disk === document.getText()) return;
        if (document.isDirty) {
          void vscode.window.showWarningMessage(
            `CodeMap: ${vscode.workspace.asRelativePath(document.uri)} changed on disk while you have unsaved changes. Save to keep yours, or revert to load the file.`,
          );
          return;
        }
        push(disk);
      }),
      onThemeChange((theme) => server.emit({ kind: "event", type: "theme", theme })),
    ];
    panel.onDidDispose(() => {
      server.dispose();
      for (const s of subscriptions) s.dispose();
      this.statuses.delete(id);
    });
  }
}

function watchFile(uri: vscode.Uri, onChange: () => Promise<void>): vscode.Disposable {
  const dir = vscode.Uri.joinPath(uri, "..");
  const name = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name), true, false, true);
  watcher.onDidChange(() => void onChange().catch(() => undefined));
  return watcher;
}

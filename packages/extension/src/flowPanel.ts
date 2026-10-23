import * as vscode from "vscode";
import { diagramToText, type Diagram } from "@tracer/core";
import { FlowEditorProvider, type Status } from "./diagramEditor";
import { serve } from "./rpc";
import { currentTheme, onThemeChange } from "./theme";
import { webviewHtml, webviewOptions } from "./webview";
import { exportFile, openSource } from "./workspace";

type State = { id: string; diagram: Diagram; root: vscode.Uri };

/**
 * The generated flow, shown beside the code. One panel is reused: asking for another flow replaces its
 * content, so the editor group does not fill with tabs. Edits and layout changes stay in memory until the
 * user saves; Save writes a `.diagram.json` (chosen in a dialog) and opens it in the flow editor.
 */
export class FlowPanel {
  private panel?: vscode.WebviewPanel;
  private state?: State;
  private seq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly statuses: Map<string, Status>,
  ) {}

  /** Shows `diagram`; resolves to the document id the webview will report its status under. */
  async show(diagram: Diagram, root: vscode.Uri): Promise<string> {
    const id = `tracer-flow:${++this.seq}`;
    if (this.state) this.statuses.delete(this.state.id);
    this.state = { id, diagram, root };
    if (!this.panel) this.create();
    const panel = this.panel as vscode.WebviewPanel;
    panel.title = `Flow: ${diagram.title}`;
    panel.webview.html = await webviewHtml(panel.webview, this.context.extensionUri); // reload: the app reads the new id
    panel.reveal(vscode.ViewColumn.Beside, true); // keep focus in the code
    return id;
  }

  private create(): void {
    const panel = vscode.window.createWebviewPanel("tracer.flow", "Tracer Flow", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      ...webviewOptions(this.context.extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    const current = (id?: string): State => {
      if (!this.state || (id !== undefined && id !== this.state.id)) throw new Error("this flow was replaced by a newer one");
      return this.state;
    };
    const unsupported = async (): Promise<never> => {
      throw new Error("not available in a generated flow");
    };
    const server = serve(
      panel.webview,
      {
        init: async () => ({ mode: "flow", documentId: current().id, ...currentTheme() }),
        loadDiagram: async ({ id }) => current(id).diagram,
        applyEdit: async ({ id, diagram }) => {
          current(id).diagram = diagram; // survives a reload
          return null;
        },
        saveDiagram: async ({ id, diagram }) => {
          const s = current(id);
          s.diagram = diagram;
          const name = diagram.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(s.root, `${name}.diagram.json`),
            filters: { "Tracer flow": ["diagram.json", "canvas"] },
            saveLabel: "Save flow",
          });
          if (!target) return null; // cancelled
          await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(diagramToText(target.path, diagram)));
          await vscode.commands.executeCommand("vscode.openWith", target, FlowEditorProvider.viewType);
          return null;
        },
        runCommand: async () => null,
        loadGraph: unsupported,
        openSource: async ({ path, line }) => openSource([current().root], path, line),
        listDiagrams: async () => [],
        exportFile: async (p) => exportFile(p, current().root),
        reportStatus: async (status) => {
          this.statuses.set(status.id, status);
          if (status.state === "error") this.output.appendLine(`[flow] ${status.detail ?? "failed"}`);
          return null;
        },
      },
      (m) => this.output.appendLine(`[flow] ${m}`),
    );
    const theme = onThemeChange((t) => server.emit({ kind: "event", type: "theme", ...t }));
    panel.onDidDispose(() => {
      server.dispose();
      theme.dispose();
      if (this.state) this.statuses.delete(this.state.id);
      this.panel = undefined;
      this.state = undefined;
    });
  }
}

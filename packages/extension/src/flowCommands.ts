import * as vscode from "vscode";
import type { FlowPanel } from "./flowPanel";
import type { FlowResult, FlowService, FlowTarget } from "./flowService";

/** What a command resolves to (the integration tests read it; the user sees the panel). */
export type FlowCommandResult = { ok: true; title: string; nodeCount: number; titles: string[]; truncated: boolean; id: string } | { ok: false; reason: string };

const traceDepth = (): number => Math.min(8, Math.max(1, vscode.workspace.getConfiguration("tracer").get<number>("flow.traceDepth", 4)));

/** The code editor a command is about: the active one, or (when the flow panel has focus) the one beside it. */
const codeEditor = (): vscode.TextEditor | undefined => vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file" || e.document.uri.scheme === "untitled");

export class FlowCommands {
  private toldPartial = false;

  constructor(
    private readonly service: FlowService,
    private readonly panel: FlowPanel,
  ) {}

  /**
   * Selection: the flow of the selected statements (a selected function: that function).
   * No selection: the function the cursor is in, else the file's overview. A file picked in the explorer: its overview.
   */
  async showFlow(resource?: unknown): Promise<FlowCommandResult> {
    const editor = codeEditor();
    // The editor menu passes the open document's own URI; a different file means the explorer menu: its overview.
    if (resource instanceof vscode.Uri && resource.toString() !== editor?.document.uri.toString()) {
      return this.run(await vscode.workspace.openTextDocument(resource), { kind: "file" });
    }
    if (!editor) return this.fail("Open a code file first.");
    const sel = editor.selection;
    if (sel.isEmpty) {
      const p = sel.active;
      return this.run(editor.document, { kind: "function", line: p.line + 1, column: p.character }, { kind: "file" });
    }
    // A selection ending at column 0 of a line does not include that line.
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return this.run(editor.document, { kind: "selection", startLine: sel.start.line + 1, endLine });
  }

  /** The control flow of the function the cursor is in. */
  async showFunctionFlow(): Promise<FlowCommandResult> {
    const editor = codeEditor();
    if (!editor) return this.fail("Open a code file first.");
    const p = editor.selection.active;
    return this.run(editor.document, { kind: "function", line: p.line + 1, column: p.character });
  }

  /** The functions the cursor's function calls (`trace`), or that call it (`callers`), across files, as a tree. */
  async traceCalls(kind: "trace" | "callers" = "trace"): Promise<FlowCommandResult> {
    const editor = codeEditor();
    if (!editor) return this.fail("Open a code file first.");
    const at = { line: editor.selection.active.line + 1, column: editor.selection.active.character };
    return this.run(editor.document, kind === "callers" ? { kind, ...at } : { kind, ...at }); // two literals: FlowTarget stays discriminated
  }

  private fail(reason: string): FlowCommandResult {
    void vscode.window.showWarningMessage(`Tracer: ${reason}`);
    return { ok: false, reason };
  }

  /** Runs `target`; when it finds nothing to draw and there is a `fallback`, runs that instead (quietly). */
  private async run(document: vscode.TextDocument, target: FlowTarget, fallback?: FlowTarget): Promise<FlowCommandResult> {
    try {
      const r: FlowResult = await this.service.flow(document.uri, document.getText(), target, traceDepth(), fallback);
      if (!r.ok && r.cancelled) return { ok: false, reason: r.reason }; // the user stopped it: no warning
      if (!r.ok) return this.fail(r.reason);
      const id = await this.panel.show(r.diagram, r.root);
      if (r.warning) void vscode.window.showWarningMessage(`Tracer: ${r.warning}`);
      if (r.truncated) void vscode.window.showInformationMessage("Tracer: the flow is large, so only the first part is drawn. Select a smaller range to see the rest.");
      if (r.partial && !this.toldPartial) {
        this.toldPartial = true;
        void vscode.window.showInformationMessage("Tracer is still reading this workspace. Calls into other files will be linked in your next flow.");
      }
      return { ok: true, title: r.diagram.title, nodeCount: r.diagram.nodes.length, titles: r.diagram.nodes.map((n) => n.title ?? ""), truncated: r.truncated, id };
    } catch (e) {
      return this.fail(`could not build the flow: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

import * as vscode from "vscode";
import type { FlowPanel } from "./flowPanel";
import type { FlowService, FlowTarget } from "./flowService";

/** What a command resolves to (the integration tests read it; the user sees the panel). */
export type FlowCommandResult = { ok: true; title: string; nodeCount: number; titles: string[]; truncated: boolean; id: string } | { ok: false; reason: string };

const traceDepth = (): number => Math.min(8, Math.max(1, vscode.workspace.getConfiguration("tracer").get<number>("flow.traceDepth", 4)));

export class FlowCommands {
  constructor(
    private readonly service: FlowService,
    private readonly panel: FlowPanel,
  ) {}

  /** Selection: the flow of the selected statements. No selection (or a file picked in the explorer): the file's overview. */
  async showFlow(resource?: unknown): Promise<FlowCommandResult> {
    const editor = vscode.window.activeTextEditor;
    if (resource instanceof vscode.Uri && resource.toString() !== editor?.document.uri.toString()) {
      return this.run(await vscode.workspace.openTextDocument(resource), { kind: "file" });
    }
    if (!editor) return this.fail("Open a file first.");
    const sel = editor.selection;
    if (sel.isEmpty) return this.run(editor.document, { kind: "file" });
    // A selection ending at column 0 of a line does not include that line.
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return this.run(editor.document, { kind: "selection", startLine: sel.start.line + 1, endLine });
  }

  /** The control flow of the function the cursor is in. */
  async showFunctionFlow(): Promise<FlowCommandResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return this.fail("Open a file first.");
    const p = editor.selection.active;
    return this.run(editor.document, { kind: "function", line: p.line + 1, column: p.character });
  }

  /** The functions the cursor's function calls, across files, as a tree. */
  async traceCalls(): Promise<FlowCommandResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return this.fail("Open a file first.");
    return this.run(editor.document, { kind: "trace", line: editor.selection.active.line + 1 });
  }

  private fail(reason: string): FlowCommandResult {
    void vscode.window.showWarningMessage(`Tracer: ${reason}`);
    return { ok: false, reason };
  }

  private async run(document: vscode.TextDocument, target: FlowTarget): Promise<FlowCommandResult> {
    try {
      const r = await this.service.flow(document.uri, document.getText(), target, traceDepth());
      if (!r.ok) return this.fail(r.reason);
      const id = await this.panel.show(r.diagram, r.root);
      if (r.truncated) void vscode.window.showInformationMessage("Tracer: the flow is large, so only the first part is drawn. Select a smaller range to see the rest.");
      return { ok: true, title: r.diagram.title, nodeCount: r.diagram.nodes.length, titles: r.diagram.nodes.map((n) => n.title ?? ""), truncated: r.truncated, id };
    } catch (e) {
      return this.fail(`could not build the flow: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

import * as vscode from "vscode";
import type { Params } from "@codemap/core";

const DIAGRAM_GLOB = "**/*.{diagram.json,canvas}";
const EXCLUDE = "**/{node_modules,dist,.git}/**";

export const findDiagrams = (): Thenable<vscode.Uri[]> => vscode.workspace.findFiles(DIAGRAM_GLOB, EXCLUDE, 1000);

export async function listDiagrams(): Promise<{ id: string; title: string }[]> {
  return (await findDiagrams())
    .map((uri) => ({ id: uri.toString(), title: vscode.workspace.asRelativePath(uri) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Opens a file the webview points at (a diagram node's `source`, a graph node). The path is relative and
 * must stay inside one of `bases` (workspace folders, the diagram's folder): no absolute paths, no `..`.
 */
export async function openSource(bases: readonly vscode.Uri[], path: string, line?: number): Promise<null> {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (/^([a-z]:|[\\/])/i.test(path) || segments.includes("..")) {
    void vscode.window.showWarningMessage(`CodeMap: refusing to open "${path}" (only paths inside the workspace are allowed).`);
    return null;
  }
  for (const base of bases) {
    const uri = vscode.Uri.joinPath(base, ...segments);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      continue;
    }
    const position = line ? new vscode.Position(line - 1, 0) : undefined;
    await vscode.window.showTextDocument(uri, { preview: true, selection: position && new vscode.Range(position, position) });
    return null;
  }
  void vscode.window.showWarningMessage(`CodeMap: "${path}" was not found in the workspace.`);
  return null;
}

/** Webviews cannot download: ask where to save, then write. Cancelling is not an error. */
export async function exportFile(p: Params<"exportFile">, near: vscode.Uri | undefined): Promise<null> {
  const ext = p.filename.slice(p.filename.lastIndexOf(".") + 1);
  const target = await vscode.window.showSaveDialog({
    defaultUri: near ? vscode.Uri.joinPath(near, p.filename) : undefined,
    filters: { [ext.toUpperCase()]: [ext] },
    saveLabel: "Export",
  });
  if (!target) return null;
  const bytes = p.encoding === "base64" ? Buffer.from(p.data, "base64") : Buffer.from(p.data, "utf8");
  await vscode.workspace.fs.writeFile(target, bytes);
  return null;
}

export const workspaceFolders = (): vscode.Uri[] => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);

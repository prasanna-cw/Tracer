import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { buildWebviewHtml } from "./html";

const distRoot = (extensionUri: vscode.Uri): vscode.Uri => vscode.Uri.joinPath(extensionUri, "dist");
const webviewRoot = (extensionUri: vscode.Uri): vscode.Uri => vscode.Uri.joinPath(extensionUri, "dist", "webview");

/** Scripts on, and the webview may load files from the extension's dist folder only. */
export const webviewOptions = (extensionUri: vscode.Uri): vscode.WebviewOptions => ({
  enableScripts: true,
  localResourceRoots: [distRoot(extensionUri)],
});

export async function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const root = webviewRoot(extensionUri);
  const index = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "index.html")));
  return buildWebviewHtml(index, {
    nonce: randomBytes(16).toString("base64"),
    cspSource: webview.cspSource,
    resourceUri: (path) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...path.split("/"))).toString(),
  });
}

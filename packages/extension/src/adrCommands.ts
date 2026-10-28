import * as vscode from "vscode";
import { adrFilename, adrTemplate, nextAdrNumber, parseAdr } from "@tracer/core";

const ADR_GLOB = "**/docs/adr/*.md";
const EXCLUDE = "**/{node_modules,dist,.git}/**";

const findAdrs = (): Thenable<vscode.Uri[]> => vscode.workspace.findFiles(ADR_GLOB, EXCLUDE, 1000);

/** The `docs/adr` folder of the first workspace folder (where a new ADR is written, and where "Open ADR" looks). */
function adrFolder(): vscode.Uri | undefined {
  const root = vscode.workspace.workspaceFolders?.[0];
  return root && vscode.Uri.joinPath(root.uri, "docs", "adr");
}

/**
 * "Tracer: New ADR…": asks for a title (unless `titleOverride` is given, e.g. from a test invoking the
 * command directly), writes `docs/adr/<NNNN>-<slug>.md` from the standard template, and opens it. Returns
 * the new file's URI, or undefined if there was nothing to create.
 */
export async function newAdr(titleOverride?: string): Promise<vscode.Uri | undefined> {
  const folder = adrFolder();
  if (!folder) {
    void vscode.window.showErrorMessage("Tracer: open a folder first.");
    return undefined;
  }
  const title = titleOverride ?? (await vscode.window.showInputBox({ title: "New Architecture Decision Record", prompt: "Title (e.g. \"Use a message queue for order events\")" }));
  if (!title) return undefined;

  const existing = (await findAdrs()).map((uri) => uri.path.slice(uri.path.lastIndexOf("/") + 1));
  const number = nextAdrNumber(existing);
  const filename = adrFilename(number, title);
  const date = new Date().toISOString().slice(0, 10);
  const uri = vscode.Uri.joinPath(folder, filename);

  await vscode.workspace.fs.createDirectory(folder);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(adrTemplate(number, title, date)));
  await vscode.window.showTextDocument(uri);
  return uri;
}

/** "Tracer: Open ADR…": lists every ADR under docs/adr (number, title, status), opens the one picked. */
export async function openAdrPicker(): Promise<void> {
  const uris = await findAdrs();
  if (!uris.length) {
    void vscode.window.showInformationMessage("Tracer: no ADRs yet. Run \"Tracer: New ADR…\" to write the first one.");
    return;
  }
  const items = await Promise.all(
    uris.map(async (uri) => {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const adr = parseAdr(text);
      const label = adr ? (adr.number !== undefined ? `${String(adr.number).padStart(4, "0")}. ${adr.title}` : adr.title) : vscode.workspace.asRelativePath(uri);
      return { label, description: adr?.status, detail: vscode.workspace.asRelativePath(uri), uri, number: adr?.number ?? 0 };
    }),
  );
  items.sort((a, b) => a.number - b.number);
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Open an architecture decision record", matchOnDescription: true });
  if (pick) await vscode.window.showTextDocument(pick.uri);
}

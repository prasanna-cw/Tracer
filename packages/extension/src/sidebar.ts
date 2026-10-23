import * as vscode from "vscode";
import { FlowEditorProvider } from "./diagramEditor";
import { findDiagrams } from "./workspace";

type Item = vscode.TreeItem & { children?: () => Promise<Item[]> };

const action = (label: string, icon: string, command: string, tooltip: string): Item => {
  const item: Item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: label };
  item.tooltip = tooltip;
  return item;
};

/** The Tracer view in the activity bar: quick actions, and the diagrams in this workspace. */
export class SidebarProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: Item): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: Item): Promise<Item[]> {
    if (parent) return (await parent.children?.()) ?? [];
    if (!vscode.workspace.workspaceFolders?.length) return []; // the welcome view takes over
    const diagrams: Item = new vscode.TreeItem("Saved flows", vscode.TreeItemCollapsibleState.Expanded);
    diagrams.iconPath = new vscode.ThemeIcon("files");
    diagrams.children = async () => {
      const files = await findDiagrams();
      if (!files.length) {
        const none: Item = new vscode.TreeItem("No *.diagram.json or *.canvas files yet");
        none.iconPath = new vscode.ThemeIcon("info");
        return [none];
      }
      return files
        .map((uri) => {
          const relative = vscode.workspace.asRelativePath(uri);
          const item: Item = new vscode.TreeItem(relative.slice(relative.lastIndexOf("/") + 1));
          item.description = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : undefined;
          item.tooltip = relative;
          item.resourceUri = uri;
          item.iconPath = new vscode.ThemeIcon("type-hierarchy-sub");
          item.command = { command: "vscode.openWith", title: "Open", arguments: [uri, FlowEditorProvider.viewType] };
          return item;
        })
        .sort((a, b) => String(a.tooltip).localeCompare(String(b.tooltip)));
    };
    return [
      action("Open Map", "type-hierarchy", "tracer.openMap", "Folders, files and how they import each other"),
      action("Open Graph", "graph", "tracer.openGraph", "Import graph of the workspace"),
      action("Open a saved flow…", "go-to-file", "tracer.openDiagram", "Pick a *.diagram.json or *.canvas file"),
      diagrams,
    ];
  }
}

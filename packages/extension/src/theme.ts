import * as vscode from "vscode";
import type { ThemeName } from "@codemap/core";

/** `codemap.theme`: "auto" follows VS Code (light themes -> Clean, dark and high-contrast dark -> Obsidian). */
export function currentTheme(): ThemeName {
  const setting = vscode.workspace.getConfiguration("codemap").get<string>("theme", "auto");
  if (setting === "clean" || setting === "obsidian") return setting;
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "clean" : "obsidian";
}

export function onThemeChange(listener: (theme: ThemeName) => void): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveColorTheme(() => listener(currentTheme())),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("codemap.theme") && listener(currentTheme())),
  );
}

import * as vscode from "vscode";
import type { ThemeName } from "@tracer/core";

export type ThemeState = { theme: ThemeName; native: boolean };

/**
 * `tracer.theme`: "auto" follows VS Code: light or dark by the active theme's kind, and `native` so the
 * webview uses VS Code's own colors. "light"/"dark" force Tracer's palette.
 */
export function currentTheme(): ThemeState {
  const setting = vscode.workspace.getConfiguration("tracer").get<string>("theme", "auto");
  if (setting === "light" || setting === "dark") return { theme: setting, native: false };
  const kind = vscode.window.activeColorTheme.kind;
  const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return { theme: light ? "light" : "dark", native: true };
}

export function onThemeChange(listener: (state: ThemeState) => void): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveColorTheme(() => listener(currentTheme())),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("tracer.theme") && listener(currentTheme())),
  );
}

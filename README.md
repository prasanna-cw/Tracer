# CodeMap Studio

Diagram canvas and code-graph prototype. It will become a VS Code extension later.

Requires Node 20.19+ and npm 10+.

## Install and run (PowerShell)

```powershell
npm install
npm run dev        # web app at http://localhost:5173
npm test           # vitest
npm run lint       # ESLint, warnings fail
npm run build      # typecheck + production build
```

## Analyze a repo

```powershell
npm run analyze -- --root C:\path\to\repo --out packages/app/public/graph.json
npm run dev    # then open the Graph tab (or http://localhost:5173/#graph)
```

The analyzer reads TypeScript and JavaScript (`.ts .tsx .js .jsx .mjs .cjs`), resolves each file against its nearest `tsconfig.json` (`paths`, `baseUrl`, `extends`; per-package in a monorepo), honors the root `.gitignore`, and skips `node_modules`, `dist`, `build`, `.git`, `coverage`. It prints a summary:

```text
files       25 (+1 skipped)
edges       29
unresolved  3
external    5
assets      0
cycles      1 (3 edges)
time        135 ms
```

- **unresolved**: relative or alias imports that point nowhere (listed in `graph.json` under `summary.unresolved`).
- **external**: packages and builtins (`react`, `node:fs`). Imports of your own npm workspace packages count as edges.
- **assets**: existing non-code files (`./app.css`).
- **skipped**: files with syntax errors (a warning names the line).

`packages/app/public/graph.json` is git-ignored. Without it, the Graph tab shows `samples/demo-graph.json`, the committed analysis of `samples/demo-repo`. Regenerate that with `npm run analyze:demo`; a test fails if it is stale.

## Graph view

| Action | How |
| --- | --- |
| Pan / zoom | drag the background, mouse wheel; **Fit** in the controls |
| Highlight a file's neighbors | hover it |
| Imports / imported-by | click a file (the lists are clickable); Esc clears |
| Open source | double-click a file, or **Open source** in the details panel |
| Move a file | drag it (pinned while dragging) |
| Find files | search box (path substring); Enter jumps to the first match |
| Filter | hide orphans, hide tests (`*.test.*`, `*.spec.*`, `__tests__/`), per folder |
| Local graph | depth slider 1-3 around the selected file |
| Cycles | **Highlight cycles** colors import cycles |
| Layout | center/repel/link force, link distance, node size, label zoom (live) |

## Convert to and from Obsidian

```powershell
npm run export:canvas -- samples/save-flow.diagram.json samples/save-flow.exported.canvas
npm run import:canvas -- samples/architecture.canvas architecture.diagram.json
```

Paths are relative to where you run the command.

## Diagram canvas

`npm run dev`, then open the URL Vite prints. Pick a diagram in the toolbar or link to one directly: `http://localhost:5173/#architecture.canvas`. Any `.diagram.json` or `.canvas` dropped into `samples/` shows up.

| Action | How |
| --- | --- |
| Pan / zoom / fit | drag the background, mouse wheel, bottom-left controls |
| Move a node | drag (toggle **Snap** for a 20px grid); arrow keys on a focused node |
| Details, open source | click a node |
| Edit text | double-click a node's text (Ctrl+Enter or click away to commit, Esc cancels), or edit in the side panel |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) |
| Save | Ctrl+S (Chrome/Edge: pick a file once, later saves write to it; other browsers download) |
| Walkthrough | toolbar button; Left/Right to step, Esc to exit, **Play** for 2.5s autoplay |

## VS Code extension

Build and install it locally (it is not published, and must not be until publisher/license are set):

```powershell
npm install
npm run package                     # -> packages\extension\codemap-studio.vsix
code --install-extension packages\extension\codemap-studio.vsix
```

Then, in VS Code:

- open any `*.diagram.json` or `*.canvas`: it opens in the **CodeMap Diagram** editor (right-click the tab, "Reopen Editor With…" for the text);
- Command Palette: **CodeMap: Open Graph View** (import graph of the first workspace folder), **CodeMap: Open Diagram**;
- setting **codemap.theme**: `auto` (follows VS Code light/dark), `clean`, `obsidian`.

To uninstall: `code --uninstall-extension todo-publisher.codemap-studio-vscode`.

Develop: open this repo in VS Code and press **F5** ("Run CodeMap extension": builds, then opens `samples/demo-repo` in an Extension Development Host). Integration tests in a real VS Code: `npm run test:vscode` (downloads VS Code, about 350 MB, on first run).

**Permissions and data handling** (details in `packages/extension/README.md`): no network access and no telemetry; activates only on its commands or when a diagram file is opened; reads the diagram you open and, for the graph, the source files, `tsconfig.json`/`package.json` and `.gitignore` of the first workspace folder; writes only the document (through VS Code) and exports you place in a save dialog; opens source files only inside the workspace.

## Samples

- `samples/save-flow.diagram.json`: native diagram with a 9-step walkthrough.
- `samples/architecture.canvas`: plain JSON Canvas. Open it in Obsidian, or import it here.

## Layout

- `packages/core`: schema, JSON Canvas I/O, graph, analyzer. No DOM, React, VS Code or fs (enforced by ESLint).
- `packages/app`: Vite + React web prototype.
- `packages/cli`: `analyze`, `export:canvas`, `import:canvas` commands.
- `packages/extension`: the VS Code extension (custom editor, graph command, webview host).
- `samples/demo-repo`: synthetic project the analyzer tests run against; `samples/demo-graph.json` is its committed graph.
- `samples/monorepo`: npm-workspaces fixture for per-package tsconfig resolution.
- `docs/SCHEMA.md`: diagram format. `docs/DECISIONS.md`: why things are the way they are.

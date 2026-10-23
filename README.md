# Tracer

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

## Convert to and from JSON Canvas

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

Build and install it locally:

```powershell
npm install
npm run package                     # -> packages\extension\tracer.vsix
code --install-extension packages\extension\tracer.vsix
```

Then, in VS Code:

- **Right-click in any code file → Tracer** (works for TypeScript, JavaScript, Java, Kotlin, Python, Go, C#, Rust, C, C++, PHP, Ruby, Swift, Scala, Dart, Lua):
  - **Show Flow**: with nothing selected, an overview of the file (its functions, what calls what, what it reaches in other files); with lines selected, the control flow of just those lines.
  - **Show Flow of This Function**: the flowchart of the function under the cursor: `if`/`else`, loops (with their back-edge), `switch`/`match`, `try`/`catch`/`finally`, returns and throws. A call that resolves to a function in your workspace links to its definition (click the card, **Open source**).
  - **Trace Calls From This Function**: the call tree across files (Controller → Service → Repository), coloured by role.
  - The diagram opens **beside** your code and is editable; **Save** writes a `.diagram.json` you can keep and annotate.
  - Also in the explorer: right-click a file for **Show Flow**, a folder for **Open Map** or **Open Graph**.
- **Tracer: Open Map** (or the Tracer icon in the activity bar): the workspace as an interactive diagram. It opens on the workspace and its biggest folders; **click a folder to open or close it**, and the imports between whatever is visible are rolled up with a count (`app → core: 15`). Click a file to light up just its imports and importers (everything else dims) and see its details. **Find a file** opens the folders on the way to it. Big folders show 30 items and a "+ N more" card. Services (folders with a `package.json`, `pom.xml`, `go.mod`, …) are marked with their build system. The **Graph** tab next to it is the free-moving dot view.
- open any `*.diagram.json` or `*.canvas`: it opens in the **Tracer Flow** editor (right-click the tab, "Reopen Editor With…" for the text);
- the **Tracer** icon in the activity bar, or the Command Palette: **Tracer: Open Graph**, **Tracer: Open Saved Flow…**;
- setting **tracer.theme**: `auto` (match VS Code), `light`, `dark`; **tracer.flow.traceDepth** (1-8, default 4).

The same diagrams from a terminal: `npm run flow -- --root <repo> --file <file> [--line N [--end M] | --trace] --out x.diagram.json`. Speed on a big workspace: `npm run bench -- --files 6000` (see `docs/DECISIONS.md` D34).

To uninstall: `code --uninstall-extension PrasannaMurugan.tracer`.

Develop: open this repo in VS Code and press **F5** ("Run Tracer extension": builds, then opens `samples/demo-repo` in an Extension Development Host). Integration tests in a real VS Code: `npm run test:vscode` (downloads VS Code, about 350 MB, on first run).

**Permissions and data handling** (details in `packages/extension/README.md`): no network access and no telemetry; activates only on its commands or when a diagram file is opened; reads the diagram you open and, for the graph, the source files, `tsconfig.json`/`package.json` and `.gitignore` of the first workspace folder; writes only the document (through VS Code) and exports you place in a save dialog; opens source files only inside the workspace.

## Samples

- `samples/save-flow.diagram.json`: native diagram with a 9-step walkthrough.
- `samples/architecture.canvas`: plain JSON Canvas (the open format other canvas tools use), imported here.

## Layout

- `packages/core`: schema, JSON Canvas I/O, graph, analyzer. No DOM, React, VS Code or fs (enforced by ESLint).
- `packages/app`: Vite + React web prototype.
- `packages/cli`: `analyze`, `export:canvas`, `import:canvas` commands.
- `packages/extension`: the VS Code extension (custom editor, graph command, webview host).
- `samples/demo-repo`: synthetic project the analyzer tests run against; `samples/demo-graph.json` is its committed graph.
- `samples/monorepo`: npm-workspaces fixture for per-package tsconfig resolution.
- `docs/SCHEMA.md`: diagram format. `docs/DECISIONS.md`: why things are the way they are.

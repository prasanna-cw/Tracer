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

## Samples

- `samples/save-flow.diagram.json`: native diagram with a 9-step walkthrough.
- `samples/architecture.canvas`: plain JSON Canvas. Open it in Obsidian, or import it here.

## Layout

- `packages/core`: schema, JSON Canvas I/O, graph, analyzer. No DOM, React, VS Code or fs (enforced by ESLint).
- `packages/app`: Vite + React web prototype.
- `packages/cli`: `analyze`, `export:canvas`, `import:canvas` commands.
- `samples/demo-repo`: synthetic project the analyzer tests run against; `samples/demo-graph.json` is its committed graph.
- `samples/monorepo`: npm-workspaces fixture for per-package tsconfig resolution.
- `docs/SCHEMA.md`: diagram format. `docs/DECISIONS.md`: why things are the way they are.

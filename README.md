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
```

(Phase 2. Until then, the command prints a notice and exits.)

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
- `packages/cli`: `analyze` command.
- `docs/SCHEMA.md`: diagram format. `docs/DECISIONS.md`: why things are the way they are.

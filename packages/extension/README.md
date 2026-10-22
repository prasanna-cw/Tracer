# CodeMap Studio for VS Code

> **TODO before any release:** set `publisher` (currently `todo-publisher`) and `license` (currently
> `UNLICENSED`, and the package is built with `--skip-license`) in `package.json`. This build is for local
> installation only and must not be published.

- **CodeMap Diagram editor** for `*.diagram.json` and `*.canvas` (JSON Canvas, Obsidian-compatible): drag, edit, walkthrough, export. Undo/redo and save are VS Code's.
- **CodeMap: Open Graph View**: the import graph of the first workspace folder (TypeScript/JavaScript).
- **CodeMap: Open Diagram**: pick any `*.diagram.json` / `*.canvas` in the workspace.
- Setting **`codemap.theme`**: `auto` (follow VS Code light/dark), `clean`, or `obsidian`.

## What it accesses, and what it does not

| | |
| --- | --- |
| Network | **None.** The extension makes no requests. The webview's Content-Security-Policy has no `http(s)` source (`connect-src` is limited to the extension's own files), so it cannot reach the network either. No remote scripts, fonts or images. |
| Telemetry | **None.** Nothing is collected or sent. |
| Activation | Only when you run one of its commands or open a `*.diagram.json` / `*.canvas` file. |
| Files read | The diagram you open. For the graph: source files (`.ts .tsx .js .jsx .mjs .cjs`), `tsconfig.json`, `package.json` names and the root `.gitignore` of the first workspace folder, skipping `node_modules`, `dist`, `build`, `.git`, `coverage`. Read in a worker thread; nothing is cached or kept after the graph is built. |
| Files written | The diagram document, only through VS Code (your edits; you save). Exports (`.canvas`, `.svg`, `.png`) only where you choose in a save dialog. |
| Files opened | "Open source" opens a file in the editor only if its path is relative and inside a workspace folder (or next to the diagram): no absolute paths, no `..`. |
| Webview | Loads files only from the extension's `dist` folder; scripts need a per-load nonce. Every message between the webview and the extension is validated against a schema in both directions. |
| Output | Analysis summaries, unresolved imports and warnings go to the **CodeMap** output channel, locally. |

## Install (local)

```powershell
code --install-extension codemap-studio.vsix
```

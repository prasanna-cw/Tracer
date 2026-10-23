# Tracer

> **TODO before any release:** set `publisher` (currently `todo-publisher`) and `license` (currently
> `UNLICENSED`, and the package is built with `--skip-license`) in `package.json`. This build is for local
> installation only and must not be published.

Trace your code: flow diagrams you can edit, and a map of how a workspace's files connect.

- **Tracer** in the activity bar: open the graph, open saved flows.
- **Tracer: Open Graph**: every file of the first workspace folder and its imports (TypeScript/JavaScript).
- **Tracer Flow editor** for `*.diagram.json` and `*.canvas` (JSON Canvas): drag, edit, walkthrough, export. Undo/redo and save are VS Code's.
- Setting **`tracer.theme`**: `auto` (match VS Code), `light`, or `dark`.

## What it accesses, and what it does not

| | |
| --- | --- |
| Network | **None.** The extension makes no requests. The webview's Content-Security-Policy has no `http(s)` source (`connect-src` is limited to the extension's own files), so it cannot reach the network either. No remote scripts, fonts or images. |
| AI / telemetry | **None.** No AI service is used and nothing is collected or sent. |
| Activation | Only when you open the Tracer view, run one of its commands, or open a `*.diagram.json` / `*.canvas` file. |
| Files read | The flow you open. For the graph: source files (`.ts .tsx .js .jsx .mjs .cjs`), `tsconfig.json`, `package.json` names and the root `.gitignore` of the first workspace folder, skipping `node_modules`, `dist`, `build`, `.git`, `coverage`. Read in a worker thread; nothing is kept after the graph is built. |
| Files written | The flow document, only through VS Code (your edits; you save). Exports (`.png`, `.svg`, `.canvas`) only where you choose in a save dialog. |
| Files opened | "Open source" opens a file in the editor only if its path is relative and inside a workspace folder (or next to the flow file): no absolute paths, no `..`. |
| Webview | Loads files only from the extension's `dist` folder; scripts need a per-load nonce. Every message between the webview and the extension is validated against a schema in both directions. |
| Output | Summaries, unresolved imports and warnings go to the **Tracer** output channel, locally. |

## Install (local)

```powershell
code --install-extension tracer.vsix
```

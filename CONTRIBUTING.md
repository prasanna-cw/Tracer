# Contributing to Tracer

Thanks for helping. Tracer is a VS Code extension that draws flow diagrams of code and maps of a workspace, entirely locally (no network, no AI, no telemetry). Please keep it that way.

## Set up

```powershell
git clone https://github.com/prasanna-cw/Tracer.git
cd Tracer
npm install
npm test            # unit tests (vitest)
npm run lint        # warnings fail
npm run package     # builds packages/extension/tracer.vsix
```

Requires Node 20.19+ and npm 10+. Press **F5** in VS Code to run the extension in a development window. `npm run test:vscode` runs the integration tests in a real VS Code (downloads it on first run).

## Layout

- `packages/core`: schema, analyzer, flow engine (no DOM, fs or vscode imports; ESLint enforces it)
- `packages/app`: the webview (React, canvas graph)
- `packages/cli`: command-line tools (`npm run flow`, `analyze`, `bench`)
- `packages/extension`: the VS Code extension
- `docs/DECISIONS.md`: why things are the way they are. Read it before changing behaviour.

## Reporting a bug

Open an issue with: the language and a small code sample, where the cursor was, which command you ran (Show Flow, Show Flow of This Function, Trace Calls, Open Map), and the text of any "Tracer: …" message. The **Tracer** output channel (View → Output) helps.

## Pull requests

- One change per pull request; explain what a user sees differently.
- Add a test that fails without your change (`packages/core/test` for engine behaviour).
- `npm test`, `npm run lint` and `npm run test:vscode` must pass.
- Adding a language: put its tree-sitter node names in `packages/core/src/engine/languages.ts` (take them from a real parse tree) and add a sample to `packages/core/test/flowSamples.ts`.

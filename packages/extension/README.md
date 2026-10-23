# Tracer

**See how your code flows.** Right-click a file or a function and get a clean flow diagram beside your code. Open the map to see how a whole workspace, from one repo to ten microservices, fits together.

Works with TypeScript, JavaScript, Java, Kotlin, Python, Go, C#, Rust, C, C++, PHP, Ruby, Swift, Scala, Dart and Lua. Everything runs on your machine: no AI, no network, no telemetry.

## What you can do

| I want to… | Do this |
| --- | --- |
| Understand a file | Right-click in the editor → **Tracer → Show Flow** |
| Understand one function | Put the cursor in it → right-click → **Tracer → Show Flow of This Function** |
| Understand a few lines | Select them → right-click → **Tracer → Show Flow** |
| See what a function ends up calling | Cursor in it → **Tracer → Trace Calls From This Function** |
| See how a repo or folder is organised | Click the **Tracer** icon in the activity bar, or run **Tracer: Open Map** |
| See files as a moving dot graph | Open the map, then the **Graph** tab |
| Flow for a file from the explorer | Right-click the file in the explorer → **Tracer → Show Flow** |

## Quick start

1. Install Tracer and open any project folder.
2. Open a code file and put the cursor inside a function.
3. Right-click → **Tracer → Show Flow of This Function**.
4. The diagram opens to the right of your code. Click any card to see its details, and **Open source** to jump to that line.

## Reading a flow

- **Rounded top card**: the function and where it lives.
- **Dashed card**: a decision (`if`, `switch`, a loop condition). Its arrows are labelled `yes` / `no` or with the case.
- **Plain cards**: steps. A call that resolves to code in your workspace shows `→ Class.method  File.ext:line`; click the card and **Open source** to go there.
- **Red cards**: `throw` / `raise` and other ways out.
- Loops draw an arrow back to the loop, `try` / `catch` / `finally` become branches.

Flows show the **structure** of the code. Nothing is guessed or written for you.

## The map

Open it from the activity bar icon or **Tracer: Open Map**.

- It starts on the workspace and its biggest folders. **Click a folder** to open or close it.
- Arrows between folders and files show imports, with counts when many are rolled up (`app → core: 15`).
- **Click a file** to light up what it imports and what imports it; everything else dims. The details panel lists them, and each is clickable.
- **Find a file** opens the folders on the way to it.
- Folders that look like a service (they hold a `package.json`, `pom.xml`, `go.mod`, `*.csproj`, …) are marked with their build system.
- Big folders show 30 items and a **+ N more** card.
- The **Graph** tab is the free-moving dot view: hover to highlight neighbours, drag to move, search, hide tests or orphans, highlight cycles. Layout options are tucked into **Layout settings**.

## Saving and sharing

- **Save** (Ctrl+S in the flow) writes a `*.diagram.json` next to your code. You can keep it, edit the text, and add notes. Double-click a card's text to edit it.
- Open any `*.diagram.json` or `*.canvas` (JSON Canvas) file and it opens in the Tracer editor. Right-click the tab → *Reopen Editor With…* for the text.
- **Walkthrough** steps through a diagram one card at a time. **Export** gives PNG, SVG or `.canvas`.
- The **⋯** menu holds Snap (align cards to a grid) and Minimap (small overview in the corner).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `tracer.theme` | `auto` | `auto` follows VS Code; or force `light` / `dark` |
| `tracer.flow.traceDepth` | `4` | How many call levels **Trace Calls** follows (1–8) |

## Good to know

- Control flow is read from the code's syntax. Lambdas and callbacks are shown as steps, not followed.
- A call is linked to its definition by name and receiver. Very common names (`get`, `add`, …) and ambiguous matches are left unlinked rather than guessed.
- Calls between services over HTTP or gRPC are not linked.
- Dart support is partial.
- Large workspaces: the first analysis of about 6,000 files takes about 12 seconds; after that, opening the map and a flow take well under a second.

## Privacy and permissions

| | |
| --- | --- |
| Network | **None.** The extension makes no requests, and its webview's Content-Security-Policy allows no `http(s)` source. No remote scripts, fonts or images. |
| AI / telemetry | **None.** No AI service is used and nothing is collected or sent. |
| Activation | Only when you open the Tracer view, run one of its commands, or open a `*.diagram.json` / `*.canvas` file. |
| Files read | The source files, build manifests (`package.json`, `pom.xml`, `go.mod`, …), `tsconfig.json` and the root `.gitignore` of your workspace folder, skipping `node_modules`, `dist`, `build`, `.git`, `coverage`. Read in a worker thread; kept in memory only. |
| Files written | A flow document only when you save it (through VS Code). Exports only where you choose in a save dialog. |
| Files opened | **Open source** opens a file only if it is inside a workspace folder: no absolute paths, no `..`. |
| Webview | Loads files only from the extension's own folder; scripts need a per-load nonce; every message to and from the extension is schema-validated. |
| Output | Summaries and warnings go to the **Tracer** output channel, locally. |

## Troubleshooting

- **No Tracer entry in the right-click menu**: the file's language may not be supported yet, or the extension has not activated: reload the window (Ctrl+Shift+P → *Developer: Reload Window*).
- **A "Tracer: …" message says no flow was found**: the cursor is probably not inside a function. Click inside one and try again.
- **A call isn't linked**: its name is common or matches several functions. Open the **Tracer** output channel (View → Output) for details.
- **Map looks stale after big changes**: run **Tracer: Refresh**.

## Install from a file

```powershell
code --install-extension tracer.vsix
```

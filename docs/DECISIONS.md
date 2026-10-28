# Decisions

Each entry: what, why, alternative considered.

## D1. `core` is consumed as TypeScript source, not built

- **What:** `@tracer/core` exports `./src/index.ts`. Vite, vitest and (later) tsx/esbuild compile it directly. `npm run build` in core is a typecheck only.
- **Why:** No build-order dance, no stale `dist/`, instant HMR across packages. The VS Code extension will be bundled with esbuild anyway.
- **Alternative:** `tsc -b` project references emitting `dist/`. Revisit if core is ever published to npm.

## D2. Toolchain versions

- **What:** TypeScript 5.9, vitest 3.2, Vite 7, ESLint 10, zod 4.
- **Why:** TS 7 (native) is not yet supported by typescript-eslint (`<6.1`). vitest 4 crashes npm 10.8's installer (`Cannot read properties of null (reading 'edgesOut')`, arborist peer-set bug), and vitest 5 needs Node 22. Vite 8 works on Node 20.19+ but 7 is the better-trodden path with plugin-react 5.
- **Alternative:** Require Node 22 + npm 11 and take the latest of everything. Cheap to do later; bump together.
- **Phase 3a:** `@vscode/vsce` 3.9 and `@vscode/test-electron` 2.5 for the same reason (their latest majors need Node 22). `@types/vscode` is pinned to 1.90.0 to match `engines.vscode: ^1.90.0`.

## D3. Every schema object is loose (unknown fields preserved)

- **What:** `z.looseObject` throughout. Unknown keys survive parse → state → save → export.
- **Why:** Round-trip with Obsidian and future plugins must not lose data.
- **Cost:** The inferred types carry an index signature, so a typo like `node.titel` compiles (as `unknown`). Acceptable; renderers read known fields only.
- **Alternative:** Strict objects with a `meta` bag per node. Cleaner types, but lossy for anything we forget to model.

## D4. Semantic validation lives in the schema

- **What:** Duplicate ids, edges to missing nodes, `file`/`link` nodes without `file`/`url`, and steps referencing unknown ids are **errors**, reported as `path: message` strings (`edges[1].toNode: unknown node "ghost"`).
- **Why:** One validator for files, hand edits, and LLM output. The path format is precise enough to feed back to an LLM for a retry.
- **Alternative:** Drop dangling edges with a warning. Friendlier for messy imports, but hides bugs.
- **Update (Obsidian fixture `samples/save-flow.edited-externally.canvas`):** deleting a card in Obsidian removes its edges, but our walkthrough `steps` (which Obsidian doesn't know about) still point at the deleted node and edges. So **JSON Canvas import repairs steps**: missing `nodeIds`/`edgeIds` are pruned, steps with no nodes left are dropped, and each repair is a warning naming the step by title and id (`Step "Entities per risk" (s5): removed missing node ent-actions`). Dangling **edges** are still errors. Obsidian never produces them, so seeing one means a hand-edit bug worth surfacing. Native `.diagram.json` loading stays strict.

## D5. JSON Canvas export: flatten + namespaced stash

- **What:** Rich text nodes export as markdown (`## title`, `*subtitle*`, text, rows as a list). The original `kind/title/subtitle/category/rows/source/text` go in a `codemap` key on the node; `style` goes in `codemap` on edges; `title/steps/meta` in a top-level `codemap`. Import restores them. A diagram with no CodeMap-only data (no steps, no meta, no extended node/edge) exports **without** a top-level `codemap` key, so a plain Obsidian canvas round-trips byte-for-byte in structure (its title is its file name).
- **Why:** Obsidian shows a readable card; we get a lossless round-trip.
- **Finding (real Obsidian output):** Obsidian preserves every `codemap` key. Editing a card changes `text` only, which leaves `codemap.title`/`rows` stale. The stash cannot be trusted blindly.
- **Edit reconciliation:** export stores `codemap.textHash` (FNV-1a of the generated markdown). On import:
  - Hash matches: `codemap` is authoritative.
  - Hash differs: the markdown wins. It is parsed back (`##` heading → `title`, a following single italic line → `subtitle`, trailing bullet list → `rows`, with italic rows muted and the first row muted for `table` kind, anything between → `text`).
  - Neither a heading nor a list remains: `title/subtitle/rows` are dropped and the node becomes `kind: "note"` with the markdown as `text`.
  - `kind/category/source` are kept in all cases, and every reconciliation emits a warning.
- **Why a stored hash** rather than regenerating and comparing: if `richMarkdown` formatting changes in a later version, regeneration would flag every old file as edited. Files exported before `textHash` existed fall back to regeneration.
- **Ambiguity accepted:** a single italic line right after the heading is always read as `subtitle`.
- **Category colors:** with no explicit `color`, known categories map to Obsidian presets on export (`db`→5 cyan, `service`→4 green, …) and are flagged `derivedColor` so import does not persist them.
- **Known limits:** if Obsidian strips unknown keys on save, the diagram degrades to plain text nodes (still valid). A user field literally named `codemap` on a node would be overwritten.
- **Alternative:** Sidecar file next to the `.canvas`. More robust to stripping, but two files to keep in sync.

## D6. Groups are geometric, not parent/child

- **What:** As in JSON Canvas, a node belongs to a group if it sits inside the group's rectangle. No `parentId`. Export orders groups first so they render underneath.
- **Alternative:** Explicit `parentId`. Would diverge from JSON Canvas.

## D7. `category` is an open string

- **What:** Any non-empty string. Seven canonical families (`CATEGORIES`: `layer, entity, db, service, data, note, warning`) have a palette in every theme. `CATEGORY_ALIASES` maps common synonyms case-insensitively (`database`/`table`/`sql` to `db`, `api`/`backend` to `service`, `model`/`domain` to `entity`, …); aliases are silent and keep their original spelling in the file. Anything else validates, gets a stable hashed fallback family, and produces one **non-fatal warning** per distinct value (`parseDiagram(...).warnings`), naming the nodes.
- **Why:** LLMs and people will write `database` or invent categories; failing on them makes generation brittle, silently ignoring them hides typos.
- **Alternative:** Closed enum (stricter, but every new word is a validation failure).

## D8. Table rows are strings with ` | ` as the cell separator

- **What:** `rows: [{ text: "id | name", muted: true }, …]`. The renderer splits on ` | ` to draw columns; a muted first row reads as a header.
- **Why:** Matches the requested `rows: {text, muted}` shape and stays readable as a markdown list in Obsidian.
- **Alternative:** `columns: string[]` + `cells: string[][]`. More structured; add if tables grow beyond display.

## D9. The architecture rule is enforced by ESLint

- **What:** `packages/core/src/**` may not import `node:*`, `fs`, `path`, `vscode`, `react`.
- **Phase 2:** the analyzer lives in core but reads files only through the `FileSystemHost` port (D19); the CLI supplies a `node:fs` implementation.

## D10. Drags commit once, on drop

- **What:** React Flow owns node positions during a drag (local state, `applyNodeChanges`). The `Diagram` gets one `move` when the drag ends (or per keyboard nudge), so one drag is one undo step. Node objects are rebuilt only when their `DiagramNode` changed (`mergeFlowNodes`), and `data` *is* the `DiagramNode`, so memoized node components skip re-rendering. Verified by a unit test on object identity.
- **Alternative:** Write every mouse move into the diagram. That re-renders the app at 60 Hz and floods undo.

## D11. `HostAdapter.exportFile` added

- **What:** `.canvas`, SVG and PNG exports go through `host.exportFile(name, data)` instead of an `<a download>` in the UI.
- **Why:** VS Code webviews block downloads; the extension host must show a save dialog. Without this, the UI would have an I/O path that bypasses the adapter.

## D12. Samples are bundled, not fetched

- **What:** `WebHost` lists and loads `samples/*.diagram.json` and `samples/*.canvas` via `import.meta.glob` (hot-reloads in dev, baked into `vite build`). `loadGraph` still fetches `/graph.json` because it is generated.
- **Why:** No dev server middleware, and the static build works without a backend. Save cannot overwrite `samples/` from a browser anyway: Chromium saves through the File System Access API (the handle is remembered per diagram for the session), other browsers download.

## D13. React Flow type `cmgroup`, not `group`

- React Flow ships default styles for its own `group` type (solid border, grey fill), which fought both themes.

## D14. Image export captures the current view

- `html-to-image` pinned to **1.11.11** (React Flow's recommendation; later versions regress on SVG). Panels (controls, minimap) are filtered out. Arrowhead markers live inside the captured element so they survive the clone.

## D15. Phase 1 limits (deliberate)

- Colored edges keep the default arrowhead color (SVG markers cannot inherit stroke in Chromium yet).
- No node creation, deletion or connecting by drag. Delete/Backspace are disabled so nothing vanishes silently.
- Exiting the walkthrough keeps the current zoom. Use fit view (bottom-left) to see everything.
- Inline markdown is a deliberate subset (`Markdown.tsx`).

## D16. Group drag moves members

- **What:** When a group drag starts, its members (nodes fully inside its rect, nested groups included: `groupMembers`) are snapshotted; every position change is fanned out to them, and the drop commits group + members as **one** `move` (one undo step). Keyboard nudges of a group carry members too (`moveGroup`). Members that are themselves selected and dragged are not moved twice.

## D17. Unknown keys: preserved, reported in dev

- **What:** `findUnknownKeys(diagram)` lists keys outside the schema (`meta` is free-form and not scanned). The web app logs them with `console.warn` in dev builds only; they are never errors and never stripped. Expect JSON Canvas plugin fields to show up there.

## D18. Analyzer: TypeScript compiler API, not ts-morph

- **What:** `ts.createSourceFile` to parse and `ts.resolveModuleName` to resolve, from the `typescript` package directly. This challenges the stack decision in the brief.
- **Why:** The analyzer needs exactly two things: the import specifiers of each file and their resolution. ts-morph wraps every AST node in an object and holds a Project of all files. At 2,000+ files that is memory and time spent on wrappers we never use. The raw API keeps one file's AST alive at a time; only specifier strings survive (pass 1), then resolution runs (pass 2). Resolution is TypeScript's own, so `paths`, `baseUrl`, `extends`, index files and `.js` → `.ts` all behave exactly as `tsc` does.
- **Counted:** `import`, `export … from`, `import x = require()`, `require("…")` (in any file type), `import("…")` with a string or plain template literal. Type-only imports count (they are dependencies too). Self-imports are dropped; edges are deduplicated.
- **Syntax errors:** read from the parser's `parseDiagnostics`. That property is internal, but it has been stable for a decade, and the public alternatives parse every file twice. The file is skipped and a warning names its line.
- **Alternative:** ts-morph as specified. Worth revisiting only if we need type information (call graphs), at which point a full Program is needed anyway.

## D19. `FileSystemHost` port; separate `@tracer/core/analyzer` entry

- **What:** The analyzer's only I/O is a five-method port (`readFile`, `fileExists`, `directoryExists`, `readDirectory`, optional `realpath`) with absolute forward-slash paths. The CLI implements it with `node:fs` (lazy reads; symlinked dirs not followed during the walk, to avoid loops). Tests use an in-memory map. The port is synchronous because `ts.resolveModuleName` is.
- **Separate entry:** `@tracer/core/analyzer` pulls in the TypeScript compiler (several MB). The app imports only `@tracer/core`; the production bundle confirms it never ships.
- **VS Code:** the extension host has `node:fs`, so it reuses the CLI's implementation. `workspace.fs` is async and would not fit.

## D20. What "unresolved" means

- **What:** Every import ends up in exactly one bucket:
  - **edge:** it resolves to a file we analyzed. This holds even when TypeScript calls it an external library, because npm workspaces resolve `@tracer/core` through a `node_modules` symlink whose real path is in the repo.
  - **asset:** a non-code file that exists (`./app.css`, `./data.json`).
  - **unresolved:** a relative, absolute or tsconfig-alias specifier that points nowhere. Up to 200 are listed with their file.
  - **external:** everything else (`react`, `node:fs`).
- **Why:** The brief lumped external and unresolved together. Separating them makes `unresolvedCount` mean "broken", which is the number worth watching. Both bugs this rule fixes (workspaces counted as external, CSS counted as unresolved) were found by analyzing this repo.
- **tsconfig:** every file resolves against its **nearest** `tsconfig.json` (walking up to the analyzed root, `extends` honored), so per-package `paths` in a monorepo work. Lookups are cached per directory, and parsed configs (with their own module-resolution cache) per tsconfig. No tsconfig on the way up means defaults (Bundler resolution, JS allowed). Fixture: `samples/monorepo`, where two packages map the same `~/*` alias to their own `src/`. Project references are not followed as such; each package's own tsconfig is what counts.
- **Limits (`ponytail:` in code):** only the root `.gitignore` is read, and its negation (`!x`) is not supported (reported as a warning). Upgrade path: the `ignore` package.

## D21. Deterministic, shareable graph.json

- **What:** Nodes and edges are sorted by code point (not `localeCompare`, which differs by locale). Timing is printed but not written. `root` is the folder name only, never an absolute path. Re-running on unchanged code gives a byte-identical file, so `samples/demo-graph.json` is committed, and a test fails if it drifts from a fresh analysis (`npm run analyze:demo` regenerates it).

## D22. Graph view: canvas + layout in a Web Worker

- **What:** One `<canvas>`. Edges are batched into one path per style (plain, cycle, focused) and nodes into one path per color/brightness bucket. Labels are drawn in screen space and culled to the viewport, and arrowheads appear from zoom 1.2. Hit testing uses a d3-quadtree, rebuilt lazily after the layout moves. The d3-force simulation runs in `layout.worker.ts` (`layoutEngine.ts` is DOM-free and unit-tested) and posts a `Float32Array` of positions per frame, plus a generation number so stale frames are dropped.
- **Why the worker:** At 2,000 files / 6,000 imports one tick costs ~25 ms (Barnes-Hut repulsion 14 ms, collision 7 ms). On the main thread the view ran at ~21 fps while laying out. With the worker, measured in Chrome via Playwright with a synthetic graph of that size: **55 fps during layout, 61 fps pan/zoom/hover/node-drag**. Collision is skipped above 1,000 nodes (layout reads fine without it, and it settles faster).
- **Colors:** by top-level folder, measured below the folder every file shares (a repo that is all `src/` would otherwise be one color). In a **monorepo** (the analyzer found `package.json` files below the root, listed in `graph.packages`), by the first **two** levels (`packages/app`), so each package gets its own color. Six theme tokens (`--graph-1..6`) cycle in natural folder order.
- **Alternative:** SVG (too slow past a few hundred nodes); WebGL (unnecessary at this scale; revisit past ~20k edges).

## D23. Demo repo as the permanent fixture

- `samples/demo-repo/` (25 analyzable files + 1 deliberately broken) covers every import form, aliases, barrels, a 3-file cycle, an orphan, tests and unresolvable imports, with exact expected numbers in its README. It is excluded from our ESLint and vitest runs. The app falls back to its committed graph when `packages/app/public/graph.json` (git-ignored) is absent.

## D24. Webview protocol in core, validated both ways

- **What:** `core/src/protocol/messages.ts` declares each request once (`methods`: params schema + result schema). The webview sends `{kind: "request", id, method, params}` and gets exactly one `response`; the extension pushes `event`s (`theme`, `documentChanged`, `documentInvalid`). The extension validates every request before a handler runs (`parseToHost`) and every response/event before posting (`okResponse`/`hostEvent` throw, so a handler bug becomes an error response, never bad data). The webview validates every message and each result against its method (`parseToWebview`, `parseResult`).
- **Why:** the webview renders file contents, so the extension treats it as untrusted, and vice versa. One table gives the types on both sides too.
- **Alternative:** hand-written message types with no runtime checks.

## D25. Custom editor: the TextDocument is the source of truth

- **What:** `CustomTextEditorProvider` for `*.diagram.json` and `*.canvas`. Each committed change in the webview (`applyEdit`) replaces the document text with one `WorkspaceEdit`: one VS Code undo step, VS Code's dirty dot, VS Code's save (and Ctrl+S/Z/Y are left to VS Code inside the webview). Changes from elsewhere (undo/redo, a text editor, VS Code reloading the file) come back as `documentChanged`; the app replaces its diagram without refitting the view. An explicit file watcher follows saves from outside (e.g. Obsidian) immediately, and warns instead of overwriting when the document has unsaved changes. The extension remembers the text the webview shows, so its own edits are never echoed back.
- **Format:** `.canvas` stays JSON Canvas (tab-indented, `codemap` stash) and `.diagram.json` stays native, via the shared `diagramToText`/`textToDiagram` in core, the same helpers the web prototype uses.
- **Alternative:** `CustomEditorProvider` with our own undo stack and backups (more control, much more code, and edits would no longer be plain text edits).

## D26. Webview security

- **CSP:** `default-src 'none'`; scripts only with the per-load nonce or from the extension's resource origin (for lazily imported chunks); `worker-src blob:`; `connect-src` limited to the extension's resources and `data:`/`blob:` (no `http(s)`, so no network); styles allow `'unsafe-inline'` because React sets `style` attributes. `localResourceRoots` is the extension's `dist` folder only.
- **Layout worker inlined** (`?worker&inline`, a `blob:` worker): a webview cannot start a Worker from its resource URL (it is cross-origin to the webview document). This replaces the Phase 2 plan of `worker-src 'self'`, which would not have worked.
- **Webview build** (`vite --mode webview`): relative asset paths, **no `public/` folder** (it may hold a local `graph.json` of the user's code, which the first build almost shipped inside the .vsix), and the web-only host and its bundled samples compiled out.
- **Host operations from the webview are fenced:** `openSource` only opens relative paths inside a workspace folder (or next to the diagram), with no `..`; `exportFile` takes a plain file name and always goes through a save dialog.

## D27. Graph command: analyzer in a worker thread

- **What:** "CodeMap: Open Graph View" runs `analyzeRepo` with the CLI's `node:fs` host in a `worker_threads` worker (`dist/analyzerWorker.js`) under a cancellable progress notification. Warnings and unresolved imports go to the CodeMap output channel. The TypeScript compiler (3.4 MB) lives only in that worker bundle; `extension.js` (460 kB) never loads it.
- **Why:** analysis takes seconds on a large repo, and the extension host is shared by every extension.

## D28. Integration tests in a real VS Code

- **What:** `@vscode/test-electron` downloads a VS Code build (cached in the OS temp folder) and runs `test/e2e/suite.ts` with only this extension enabled, on `samples/demo-repo`. The extension exports `statusOf(uri)`: the webview reports `loaded`/`error` (with the node count or the error), so tests can assert a document actually rendered through the CSP, the bundle and the protocol. A small harness replaces mocha.
- **Windows quirks handled in `runTests.ts`:** (1) `ELECTRON_RUN_AS_NODE` is inherited when tests are started from a terminal inside VS Code, and makes the test VS Code start as plain Node, so it is removed. (2) Paths with spaces (`rust learning`) are split by the launcher, so a space-free junction to the repo is created in the temp folder.
- **Tested version:** the current stable VS Code (1.143.0 at the time), not the `engines` minimum (1.90).

## D29. Tracer: name, look, Light/Dark

- **Name:** the product is **Tracer** (extension id `PrasannaMurugan.tracer-code-flow`, commands `tracer.*`, setting `tracer.theme`, editor `tracer.flowEditor`). Internal packages are `@tracer/*`. The JSON Canvas stash key is now `tracer`; files written with the old `codemap` key still import.
- **Themes:** Light and Dark (Tracer palettes) plus **native**: with `tracer.theme: auto` in VS Code, the chrome uses VS Code's own theme variables (`--vscode-*`, `themes/native.css`), so it matches any theme including high contrast; category and graph colors follow VS Code's light/dark kind. In the browser the default follows the OS preference.
- **UI:** compact 40px toolbar of codicon buttons (VS Code's icon font, bundled, no network) with tooltips; Flow | Graph segmented switch; Snap/Minimap/exports in a **⋯** menu; walkthrough as a floating card with a progress strip.
- **Graph defaults:** search, three filter chips and zoom buttons are all that is shown; Folders and **Layout settings** (the force sliders) are collapsed. The ~12 most-connected files are always labelled so the overview names what matters; labels have a background halo.
- **Graph smoothness:** the worker lays new files out off-screen first (up to 600 ms) so the first frame is near final and is fitted at once (measured: first frame 232 ms after opening this repo's graph); nothing is drawn before positions exist; hover hit-testing is coalesced to one per frame; canvas pixel ratio capped at 2. The dev server pre-bundles `d3-force` (it is only imported by the inline worker, and late discovery forced a page reload).
- **Activity bar:** a Tracer view container (monochrome glyph `media/tracer.svg`) with a sidebar: Open Graph, Open a saved flow, and the workspace's saved flows (refreshes on file create/delete). Extension icon `media/icon.png` (rendered from SVG).
- **No AI:** decided with the Founder: Tracer uses no LLM or AI service. Flows are derived from the code's structure (and can be edited by hand).

## D30. Show Flow: structure only, generic over languages

- **What:** one control-flow builder (`engine/flow.ts`) reads every language through its spec (`engine/languages.ts`: which node types are ifs, loops, switches, tries, returns, throws, calls). Statements without calls are merged ("3 statements"); statements with calls get a card; a resolved call links the card to the callee's definition. Diagrams are capped at 80 nodes with a notice. `elif`/`elsif`, Ruby `raise` and Go `panic` are treated as the constructs they are.
- **No AI, so no prose:** the cards say what the code does (`repo.save(order)`, `qty <= 0`), never why. The diagram is editable and can be saved, so a human adds the why.
- **Known limits:** control flow is syntactic. It does not know which branch runs, does not follow lambdas, callbacks or reflection, and Ruby-style `each do … end` blocks are steps, not loops. Dart is partial (conditions of `if` are not always extracted). Calls resolve by name and receiver (below), not by types.

## D31. Call resolution is heuristic and says so by staying silent

- **What:** a call `a.b.save()` resolves to a workspace function when exactly one candidate fits: name, then receiver (`repo` matches a container whose name contains "repo"), then same file, then same service. Ambiguous matches and very common names (`get`, `log`, `add`, …) on an unknown receiver stay unresolved rather than guessing. Constructors (`new Order`) resolve to the type.
- **Why:** a wrong link is worse than no link. Unresolved calls are still listed as plain rows.
- **Alternative:** real type resolution per language (language servers). Possible later through VS Code's own providers; out of scope for a local, no-dependency tool.

## D32. Layout with dagre, panel reuse, index lifecycle

- **Layout:** `layoutFlow` (dagre) lays out every generated diagram in layers: cycles are broken for us, long edges get reserved space, and loops' back-edges are drawn on the left. A hand-written structured layout was tried on paper and rejected: loops, switches and merged exits need a general algorithm anyway.
- **Panel:** one Tracer flow panel opens beside the code and is reused (its content replaced), so repeated use does not fill the editor with tabs. Edits live in memory; **Save** writes a `.diagram.json` and opens it in the flow editor.
- **Index:** per workspace root, every function and type are indexed once in a worker thread, then kept fresh by a file watcher (changed files re-parsed one at a time). The file being flowed is always parsed from the editor's text, so unsaved edits are reflected.
- **Tests inside VS Code:** each run uses a fresh profile (a restored window from an earlier run re-ran the suite), the workspace is `samples/polyglot`, and URIs are built from the workspace folder (the window is opened through a junction while `__dirname` is the real path).

## D33. The workspace map

- **What:** `core/graph/map.ts` turns the analyzer's `CodeGraph` into a `Diagram` (the same schema as every other diagram, so the canvas, the side panel, exports and themes all work unchanged). The folder tree is built from file paths, chains of single-child folders are merged (`src/main/java/com/acme` is one card), each top-level branch gets its own colour, and imports are **rolled up to the nearest visible card** with a count. The app keeps the expand state and asks for a new diagram on each click; it is pure, so it is unit-tested (roll-up counts are checked against a brute-force count, paging, reveal, layout overlap).
- **Why not drawn from the graph view?** Dots and lines do not say "this is the orders service and it depends on billing 14 times". The map answers that first and lets you drill in; the graph stays for exploring individual files.
- **Scale:** at most 30 children per folder per page (a "+ N more" card pages in 30 more), at most 250 roll-up edges (heaviest first), so a card count stays in the low hundreds however big the repo.
- **Reading a crowded map:** selecting a card keeps it, its neighbours and its links bright and dims the rest (the walkthrough's dimming, reused).
- **Both views share one analysis:** the Map and Graph tabs read the same graph, loaded once per panel.

## D34. Big workspaces: measured

`npm run bench -- --files N` generates a throwaway workspace of 10 services in 8 languages (Java, Kotlin, Python, Go, C#, PHP, Ruby, TypeScript; every file imports three earlier files of its service) and times what Tracer does on a real repo. Windows laptop, files freshly written (so antivirus scans every first read), warm node:

| 6,025 files, 60,826 imports | before | now |
| --- | --- | --- |
| Open Map / Graph: analyze everything (parse, resolve, link) | 18.2 s | **12.3 s** |
| First Show Flow / Trace Calls: index every function | 36.2 s | **11.5 s** |
| Map: open / click a folder | 57 ms / 34 ms | **61 ms / 21 ms** |
| One flow or one call trace (index already built) | 50 ms | **13 ms** |
| Memory | | 258 MB |

- **What made it faster:** reading was most of the time (2.6 ms per file here: antivirus and cold caches), and it was one file at a time. `prefetch` now keeps 48 reads in flight (bounded to ~400 MB held), then parsing and linking use the cached text. Parsing itself is ~1.8 ms/file.
- **Pays once:** the analysis and the index run in a worker thread (the editor stays responsive; progress is shown) and are kept per panel / per workspace; later flows and traces take milliseconds, and the file watcher re-parses only changed files.
- **Not done, and where the next gains are:** parse across several worker threads (parsing is ~40% of what is left). The index is now persisted on disk (D35), so a restart is instant for unchanged files.
- **Limits that remain:** a graph above ~20,000 files is analyzed in tens of seconds; the Graph tab draws thousands of dots well (55-61 fps at 2,000 files) but the Map is the better first view at that size; cross-service calls over HTTP/gRPC/queues are not linked (only code that imports or names other code, plus docker-compose's `depends_on`, D37).

## D35. Persistent, incremental analysis cache

- **What:** `FileCache` (`packages/cli/src/cache.ts`) keeps one JSON file per analyzed root at `~/.tracer/cache/<hash of the root path>.json`, entries keyed by `kind` (`ts` or `facts`) and path, validated by size and mtime. `analyzeWorkspace` and `indexWorkspace` (`packages/cli/src/workspace.ts`) check it before reading or parsing a file; a hit skips both. The two share "facts" entries for non-TypeScript files, so opening Map/Graph once speeds up the first Show Flow index too, and vice versa.
- **Why not in the repo:** this tool analyzes arbitrary projects, not just itself; a cache file under the analyzed folder would pollute someone else's repo (and need a `.gitignore` entry nobody asked for).
- **Determinism:** a cache hit returns the exact same `TsFileFacts`/`FileFacts` a fresh parse would, so the graph is still byte-identical (D21) regardless of what is cached.
- **Limits (`ponytail:` in code):** last-write-wins under two concurrent analyses of the same root (a lost update is a cache miss next time, never a wrong result); a cache-format bump invalidates the whole file, no migration.

## D36. Live refresh: Map/Graph updates while open

- **What:** `openGraphView` watches the analyzed folder (`vscode.RelativePattern` + the same source glob Show Flow's index uses) and, on a change, re-analyzes in the background (`Coalesced`, `packages/extension/src/coalesce.ts`: 500 ms after the last change, and a change mid-run queues exactly one more pass after, never piles up) and pushes the new graph as a `graphUpdated` event. Shown with quiet window-level progress, not a notification toast: this can fire on every save.
- **Observability:** the panel's latest `nodeCount` is written into the same `statuses` map the flow/diagram editors already expose via `ext.exports.statusOf`, so integration tests can watch a live refresh land without a handle to the webview.
- **Found by testing it for real:** a first version watched an external temp folder and the refresh never fired — VS Code's recursive watcher does not reliably cover paths outside the open workspace. The fix, and the lesson for any similar feature: put the fixture inside the open workspace.
- **Known limit, fixed:** the Graph's layout effect recreated every `SimNode` (and so every position) on each graph change, including a live refresh — so even an unchanged file restarted from the center. `GraphView` now carries positions across the old worker's teardown into the new one (a ref holding the last settled `{x, y}` per id, seeded in just before the old worker is terminated); only files absent from that map (genuinely new) get the worker's existing off-screen warm-up. The Map needed no equivalent fix: it keeps its expand state and redraws cleanly off `graph` plus local UI state (D33).
- **Test robustness, found by actually rerunning it:** the integration test (D28's harness) timed out intermittently on a second run right after a first — reproducibly, not a one-off. Root cause: when `waitFor` throws, the panel is never closed, so its `CancellationTokenSource` never fires, so a still-in-flight background refresh keeps its file handles open; the test's cleanup (`rmSync`) then raced a Windows/antivirus lock on a just-read file (D34) and partially failed, leaving debris for later tests to miscount. Fixed by closing the panel defensively in `finally` (before cleanup, not only on the happy path) and retrying the delete for up to 3 s. Confirmed by running the full suite twice back to back, repeatedly, with no gap.

## D37. Docs and docker-compose: cross-links into the same graph

- **What:** `.md`/`.mdx` files and docker-compose files (`docker-compose*.yml`, `compose.yml`, overrides) become graph nodes like any source file, linked with the same `source`/`target` edges the import graph uses, not a new edge kind, so the existing Map/Graph rendering and roll-up (`map.ts`) show them for free. An edge whose endpoints are not real file nodes is silently dropped by the roll-up, which is why both doc links and compose links resolve to real files rather than inventing folder- or service-level nodes.
- **Docs:** a relative link (`[x](./path)`) resolves like any other path reference. A code span (`` `Name` ``) resolves to the one file whose tree-sitter facts declare that exact name; two or more candidates and it is left unlinked (D31's rule: a wrong link is worse than no link). Names come from non-TypeScript languages' facts only; a TypeScript-only repo still gets link resolution, just not code-span matching.
- **docker-compose:** a small indentation-tree reader (`composeLinks.ts`, not a general YAML parser: no anchors, no flow style, no multi-document files) reads each service's `build` context and `depends_on`. A compose service resolves to a known code service only on an exact build-context match. `depends_on` between two resolved services becomes an edge between one real file from each (first by path order, so it stays deterministic); an `image:`-only dependency (a database, a queue) is simply not linked.
- **Found while shipping it:** a root-level file (every real repo has at least a README) broke `groupResolver`'s shared-folder-prefix detection for the Graph's folder coloring, since that heuristic assumed every file had a parent folder. Fixed by excluding root-level files from the prefix computation (`packages/app/src/graph/graphModel.ts`).
- **Not done:** Kubernetes manifests, Terraform/Ansible and other infra-as-code formats; only docker-compose is read so far.

## D38. Galaxy: a 3D view, as a third tab, lazy-loaded

- **What:** `GalaxyView.tsx` adds "Galaxy" alongside Map and Graph (same `View`/`ViewTabs` plumbing, `#galaxy` hash in the web prototype). Files are spheres (Three.js `InstancedMesh`, one draw call), edges are a single `LineSegments`, colour follows the same folder-group palette as the Graph tab. No new physics: x/y come from the *same* `layoutEngine.ts`/`layout.worker.ts` 2D force simulation Graph already uses, run in Galaxy's own worker instance; z is a fixed depth plane per top-level folder/package, so services visually separate without inventing a 3D force model. Positions carry across a live refresh the same way as D36's fix (a `lastPositions` ref seeded before the old worker is torn down).
- **Why lazy:** Three.js is ~520 kB. `App.tsx` imports it via `React.lazy`/`Suspense`, so it is its own chunk that only downloads when Galaxy is actually opened — Map, Graph and Flow's bundle size is unchanged. The webview's CSP already anticipated this (D26: "lazily imported chunks" from the extension's own resource origin).
- **Scoped down from Graph:** no filters, search, local-graph depth or cycle highlighting yet; click opens source, hover highlights and labels, drag/scroll orbits and zooms (`OrbitControls`).
- **Not verified:** no automated test (no React-component or WebGL test precedent in this codebase, same as GraphView/MapView/renderer.ts) — needs a human to actually look at it (`npm run dev` → Galaxy tab, or F5 in VS Code) before shipping.

## D39. Coverage diagnostics: lcov/Cobertura, Map only

- **What:** `graph/coverage.ts` reads lcov and Cobertura (auto-detected by content, `parseCoverage`) — the two formats virtually every test runner already exports (Jest/Vitest, pytest-cov, go test -cover, …). Lines are unioned by line number across repeated records for the same file (two `SF:` blocks, several Cobertura `<class>`s in one file), so nothing is double-counted. `applyCoverage` attaches `{linesCovered, linesTotal}` to matching `CodeGraphNode`s by exact path, or by an unambiguous absolute-prefix/relative-suffix match; an ambiguous match is left uncovered (same rule as D31, D37: a wrong link is worse than no link).
- **Command:** **Tracer: Load Coverage Report…** picks a file and merges it into every currently open Map/Graph panel via the exact same `graphUpdated` live-push D36 built — coverage is just another way to produce an updated graph, not a new mechanism.
- **UI, Map only:** a file's card shows `NN% covered` and tints "warning" below 50%. **Not done in Graph or Galaxy** — scoped to the one view for this pass.
- **Not done:** per-folder aggregate coverage (a folder card showing its files' combined rate); any format besides lcov/Cobertura.

## D40. ADR management: plain Markdown, no new mechanism

- **What:** **Tracer: New ADR…** writes `docs/adr/<NNNN>-<slug>.md` from the standard (Nygard/`adr-tools`) template — a numbered heading, `Status:`/`Date:` fields, Context/Decision/Consequences sections — numbering one past the highest existing `NNNN-` prefix, and opens it in the real editor. **Tracer: Open ADR…** lists every ADR under `docs/adr` (parsed title, number, status) in a `QuickPick`.
- **Why no new file format or view:** an ADR is a plain Markdown file, so D37's doc linking already indexes it (relative links, code-span symbol matches) with zero extra work; `docLinks.ts` only tags its `lang` as `"adr"` instead of `"markdown"` (one regex on the folder path) so Map folder badges can tell the two apart. There is no dedicated ADR panel: editing an ADR is editing a text file, same philosophy as D30's "no AI, so no prose — a human adds the why."
- **Not done:** status transitions (Accepted/Superseded) are edited by hand, not automated; no sidebar/tree view (a `QuickPick`, same as D-less precedent `tracer.openDiagram`, was enough).
- **Tested:** `parseAdr`/`slugify`/`nextAdrNumber`/`adrTemplate` are pure and unit-tested; `tracer.newAdr`'s actual file-write is covered end to end (same pattern as D36: the command takes an optional title so a test can supply one directly, bypassing the input box, the same way `tracer.openGraph` already takes an optional target `Uri`).

## Phase 3 seams (not built)

- **Staleness:** extend `source` with `hash` (content hash of the referenced range or file). The host recomputes and the canvas badges nodes whose hash differs. Because `source` is loose today, adding the field is backward compatible.

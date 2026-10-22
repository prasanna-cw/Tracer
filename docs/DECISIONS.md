# Decisions

Each entry: what, why, alternative considered.

## D1. `core` is consumed as TypeScript source, not built

- **What:** `@codemap/core` exports `./src/index.ts`. Vite, vitest and (later) tsx/esbuild compile it directly. `npm run build` in core is a typecheck only.
- **Why:** No build-order dance, no stale `dist/`, instant HMR across packages. The VS Code extension will be bundled with esbuild anyway.
- **Alternative:** `tsc -b` project references emitting `dist/`. Revisit if core is ever published to npm.

## D2. Toolchain versions

- **What:** TypeScript 5.9, vitest 3.2, Vite 7, ESLint 10, zod 4.
- **Why:** TS 7 (native) is not yet supported by typescript-eslint (`<6.1`). vitest 4 crashes npm 10.8's installer (`Cannot read properties of null (reading 'edgesOut')`, arborist peer-set bug), and vitest 5 needs Node 22. Vite 8 works on Node 20.19+ but 7 is the better-trodden path with plugin-react 5.
- **Alternative:** Require Node 22 + npm 11 and take the latest of everything. Cheap to do later; bump together.

## D3. Every schema object is loose (unknown fields preserved)

- **What:** `z.looseObject` throughout. Unknown keys survive parse → state → save → export.
- **Why:** Round-trip with Obsidian and future plugins must not lose data.
- **Cost:** The inferred types carry an index signature, so a typo like `node.titel` compiles (as `unknown`). Acceptable; renderers read known fields only.
- **Alternative:** Strict objects with a `meta` bag per node. Cleaner types, but lossy for anything we forget to model.

## D4. Semantic validation lives in the schema

- **What:** Duplicate ids, edges to missing nodes, `file`/`link` nodes without `file`/`url`, and steps referencing unknown ids are **errors**, reported as `path: message` strings (`edges[1].toNode: unknown node "ghost"`).
- **Why:** One validator for files, hand edits, and LLM output. The path format is precise enough to feed back to an LLM for a retry.
- **Alternative:** Drop dangling edges with a warning. Friendlier for messy imports, but hides bugs.
- **Update (Obsidian fixture `samples/save-flow.edited-in-obsidian.canvas`):** deleting a card in Obsidian removes its edges, but our walkthrough `steps` (which Obsidian doesn't know about) still point at the deleted node and edges. So **JSON Canvas import repairs steps**: missing `nodeIds`/`edgeIds` are pruned, steps with no nodes left are dropped, and each repair is a warning naming the step by title and id (`Step "Entities per risk" (s5): removed missing node ent-actions`). Dangling **edges** are still errors. Obsidian never produces them, so seeing one means a hand-edit bug worth surfacing. Native `.diagram.json` loading stays strict.

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
- **Phase 2 note:** ts-morph is filesystem-backed by default. Plan: the CLI reads files and hands core an in-memory file map (ts-morph `useInMemoryFileSystem`), keeping the analyzer pure and runnable in a VS Code host.

## D10. Drags commit once, on drop

- **What:** React Flow owns node positions during a drag (local state, `applyNodeChanges`). The `Diagram` gets one `move` when the drag ends (or per keyboard nudge), so one drag is one undo step. Node objects are rebuilt only when their `DiagramNode` changed (`mergeFlowNodes`), and `data` *is* the `DiagramNode`, so memoized node components skip re-rendering. Verified by a unit test on object identity.
- **Alternative:** Write every mouse move into the diagram. That re-renders the app at 60 Hz and floods undo.

## D11. `HostAdapter.exportFile` added

- **What:** `.canvas`, SVG and PNG exports go through `host.exportFile(name, data)` instead of an `<a download>` in the UI.
- **Why:** VS Code webviews block downloads; the extension host must show a save dialog. Without this, the UI would have an I/O path that bypasses the adapter.

## D12. Samples are bundled, not fetched

- **What:** `WebHost` lists and loads `samples/*.{json,canvas}` via `import.meta.glob` (hot-reloads in dev, baked into `vite build`). `loadGraph` still fetches `/graph.json` because it is generated.
- **Why:** No dev server middleware, and the static build works without a backend. Save cannot overwrite `samples/` from a browser anyway: Chromium saves through the File System Access API (the handle is remembered per diagram for the session), other browsers download.

## D13. React Flow type `cmgroup`, not `group`

- React Flow ships default styles for its own `group` type (solid border, grey fill), which fought both themes.

## D14. Image export captures the current view

- `html-to-image` pinned to **1.11.11** (React Flow's recommendation; later versions regress on SVG). Panels (controls, minimap) are filtered out. Arrowhead markers live inside the captured element so they survive the clone.

## D16. Group drag moves members

- **What:** When a group drag starts, its members (nodes fully inside its rect, nested groups included: `groupMembers`) are snapshotted; every position change is fanned out to them, and the drop commits group + members as **one** `move` (one undo step). Keyboard nudges of a group carry members too (`moveGroup`). Members that are themselves selected and dragged are not moved twice.

## D17. Unknown keys: preserved, reported in dev

- **What:** `findUnknownKeys(diagram)` lists keys outside the schema (`meta` is free-form and not scanned). The web app logs them with `console.warn` in dev builds only; they are never errors and never stripped. Expect JSON Canvas plugin fields to show up there.

## D15. Phase 1 limits (deliberate)

- Colored edges keep the default arrowhead color (SVG markers cannot inherit stroke in Chromium yet).
- No node creation, deletion or connecting by drag. Delete/Backspace are disabled so nothing vanishes silently.
- Exiting the walkthrough keeps the current zoom. Use fit view (bottom-left) to see everything.
- Inline markdown is a deliberate subset (`Markdown.tsx`).

## Phase 3 seams (not built)

- **VS Code host:** implements `HostAdapter` with `postMessage` request/response (id-correlated). It serves the same Vite bundle in a webview with a nonce CSP and watches `**/*.diagram.json`, `**/*.canvas` and `graph.json`. Nothing in core or the renderers touches I/O, so the bundle is host-agnostic.
- **Custom editor:** `CustomTextEditorProvider` for `*.diagram.json`, so VS Code owns undo/dirty state at the document level, plus an `Open Graph View` command.
- **LLM generation:** prompt with the `diagramSchema` (convertible to JSON Schema via zod 4's `z.toJSONSchema`), validate with `parseDiagram`, retry with the `errors` array.
- **Staleness:** extend `source` with `hash` (content hash of the referenced range or file). The host recomputes and the canvas badges nodes whose hash differs. Because `source` is loose today, adding the field is backward compatible.

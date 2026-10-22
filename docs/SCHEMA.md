# Diagram schema (v1)

A `Diagram` is a superset of [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). The source of truth is
[`packages/core/src/schema/diagram.ts`](../packages/core/src/schema/diagram.ts). Validate with `parseDiagram(json)`.

Unknown fields are preserved everywhere.

## Document

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | required |
| `title` | string | required, may be empty |
| `nodes` | `DiagramNode[]` | required, may be empty |
| `edges` | `DiagramEdge[]` | required, may be empty |
| `steps` | `WalkthroughStep[]` | optional guided flow |
| `meta` | object | optional, free-form, preserved |

## DiagramNode

| Field | Type | Notes |
|---|---|---|
| `id` | string | unique among nodes |
| `type` | `"text" \| "group" \| "file" \| "link"` | JSON Canvas types |
| `x`, `y`, `width`, `height` | number | pixels; `width`/`height` > 0. Exported as integers |
| `color` | `"1"`..`"6"` or `#rgb`/`#rrggbb` | presets: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple |
| `text` | string | markdown (text nodes) |
| `label` | string | group label |
| `file`, `subpath` | string | required `file` for `type: "file"` |
| `url` | string | required for `type: "link"` |
| `kind` | `"layer" \| "entity" \| "data" \| "table" \| "note" \| "start"` | picks the node component |
| `title`, `subtitle` | string | card heading |
| `category` | string | color family: `layer, entity, db, service, data, note, warning`; unknown values get a fallback color |
| `rows` | `{ text, muted? }[]` | table/data rows. Cells separated by ` \| `; a muted first row is a header |
| `source` | `{ path, line? }` | link to code (`line` is 1-based) |

Group membership is geometric: a node is in a group when it lies inside the group's rectangle.

## DiagramEdge

| Field | Type | Notes |
|---|---|---|
| `id` | string | unique among edges |
| `fromNode`, `toNode` | string | must reference existing nodes |
| `fromSide`, `toSide` | `"top" \| "right" \| "bottom" \| "left"` | optional; chosen automatically when missing |
| `fromEnd`, `toEnd` | `"none" \| "arrow"` | JSON Canvas defaults: from `none`, to `arrow` |
| `label` | string | pill on the edge |
| `color` | as nodes | |
| `style` | `"solid" \| "dashed"` | extension |

## WalkthroughStep

| Field | Type | Notes |
|---|---|---|
| `id` | string | unique among steps |
| `title` | string | non-empty |
| `description` | string | short markdown |
| `nodeIds` | string[] | at least one, must exist |
| `edgeIds` | string[] | optional, must exist |

## Validation errors

`parseDiagram` returns `{ ok: true, value }` or `{ ok: false, errors }`, where each error is `path: message`:

```
nodes[1].width: Invalid input: expected number, received undefined
nodes[2].id: duplicate node id "a"
edges[1].toNode: unknown node "ghost"
steps[0].edgeIds[0]: unknown edge "nope"
```

## JSON Canvas interop

- `toJsonCanvas(diagram)` returns a valid `.canvas` object. Rich nodes become markdown text; extension fields are kept under a `codemap` key (on nodes, edges, and the document) so `fromJsonCanvas(toJsonCanvas(d))` is lossless.
- `fromJsonCanvas(json, { title })` accepts any JSON Canvas and returns `{ ok, value | errors, warnings }`. If a rich node's markdown was edited in Obsidian (detected via `codemap.textHash`), the markdown wins and is parsed back into `title/subtitle/text/rows`. Walkthrough steps pointing at nodes or edges deleted in Obsidian are pruned. Every repair is listed in `warnings`. See `docs/DECISIONS.md` D4 and D5.

## Example

```json
{
  "version": 1,
  "title": "Order checkout",
  "nodes": [
    { "id": "g-db", "type": "group", "label": "Database", "x": -20, "y": 280, "width": 340, "height": 180 },
    { "id": "start", "type": "text", "kind": "start", "title": "User clicks Pay", "x": 40, "y": 0, "width": 220, "height": 60 },
    {
      "id": "svc", "type": "text", "kind": "layer", "category": "service",
      "title": "CheckoutService", "subtitle": "placeOrder()",
      "rows": [{ "text": "Reserve stock" }, { "text": "Charge card" }],
      "source": { "path": "src/checkout/service.ts", "line": 12 },
      "x": 0, "y": 120, "width": 300, "height": 120
    },
    {
      "id": "orders", "type": "text", "kind": "table", "category": "db", "title": "orders",
      "rows": [{ "text": "id | total", "muted": true }, { "text": "41 | 19.99" }],
      "x": 0, "y": 320, "width": 300, "height": 120
    }
  ],
  "edges": [
    { "id": "e1", "fromNode": "start", "fromSide": "bottom", "toNode": "svc", "toSide": "top" },
    { "id": "e2", "fromNode": "svc", "toNode": "orders", "label": "INSERT", "style": "dashed" }
  ],
  "steps": [
    { "id": "s1", "title": "Click", "description": "Checkout starts.", "nodeIds": ["start"] },
    { "id": "s2", "title": "Service", "description": "One transaction.", "nodeIds": ["svc"], "edgeIds": ["e1"] },
    { "id": "s3", "title": "Persist", "description": "Row written.", "nodeIds": ["g-db", "orders"], "edgeIds": ["e2"] }
  ]
}
```

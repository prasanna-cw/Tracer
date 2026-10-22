import type { Diagram, DiagramNode, ParseResult } from "../schema/diagram";
import { parseDiagram, resolveCategory } from "../schema/diagram";

/**
 * JSON Canvas 1.0 <-> Diagram.
 *
 * Export flattens rich nodes into markdown `text` so Obsidian shows something sensible, and
 * stashes the original extension fields under a namespaced `codemap` key together with a hash
 * of the generated markdown. On import:
 * - hash matches: nothing was edited, `codemap` is authoritative (lossless round-trip);
 * - hash differs: the markdown was edited outside CodeMap, so it is the source of truth and the
 *   rich fields are re-read from it (or dropped if it no longer has their shape).
 * Import is lenient where Obsidian is known to leave debris (walkthrough steps pointing at
 * deleted nodes/edges) and reports every repair as a warning.
 */

const EXT_KEY = "codemap";

type Rec = Record<string, unknown>;
type Rich = Pick<DiagramNode, "title" | "subtitle" | "text" | "rows">;
export type JsonCanvas = { nodes: Rec[]; edges: Rec[] } & Rec;
export type ImportResult = ParseResult<Diagram>;

// Preset colors Obsidian understands: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple.
const CATEGORY_PRESET: Record<string, string> = {
  db: "5",
  service: "4",
  layer: "6",
  entity: "2",
  data: "3",
  warning: "1",
};

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// ponytail: FNV-1a 32-bit, edit detection only (not security). Sync and DOM/Node-free, unlike SubtleCrypto/node:crypto.
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function richMarkdown(n: Rich): string {
  const parts: string[] = [];
  if (n.title) parts.push(`## ${n.title}`);
  if (n.subtitle) parts.push(`*${n.subtitle}*`);
  if (n.text) parts.push(n.text);
  if (n.rows?.length) parts.push(n.rows.map((r) => (r.muted ? `- *${r.text}*` : `- ${r.text}`)).join("\n"));
  return parts.join("\n\n");
}

/** Inverse of richMarkdown. Returns undefined when the markdown has neither a `## ` heading nor a bullet list. */
export function parseRichMarkdown(md: string, isTable: boolean): Rich | undefined {
  const blocks = md
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: Rich = {};
  const first = blocks[0];
  if (first?.startsWith("## ") && !first.includes("\n")) {
    out.title = first.slice(3).trim();
    blocks.shift();
    const sub = blocks[0];
    if (sub && /^\*[^*\n](?:[^\n]*[^*\n])?\*$/.test(sub)) {
      out.subtitle = sub.slice(1, -1);
      blocks.shift();
    }
  }
  const last = blocks.at(-1);
  const lines = last?.split("\n") ?? [];
  if (lines.length && lines.every((l) => /^[-*+] /.test(l))) {
    blocks.pop();
    out.rows = lines.map((l, i) => {
      const t = l.slice(2).trim();
      const italic = /^\*(.+)\*$/.exec(t);
      return italic || (isTable && i === 0) ? { text: italic?.[1] ?? t, muted: true } : { text: t };
    });
  }
  if (blocks.length) out.text = blocks.join("\n\n");
  return out.title !== undefined || out.rows ? out : undefined;
}

/** Narrow untrusted `codemap` fields to what richMarkdown needs; malformed values are ignored, not thrown on. */
function asRich(f: Rec, text: string | undefined): Rich {
  const rows = Array.isArray(f.rows)
    ? f.rows.filter(isRec).map((r) => ({ text: String(r.text), ...(r.muted === true && { muted: true }) }))
    : undefined;
  return { title: str(f.title), subtitle: str(f.subtitle), text, rows };
}

const isRich = (n: Rich): boolean => Boolean(n.title || n.subtitle || n.rows?.length);

export function toJsonCanvas(diagram: Diagram): JsonCanvas {
  const { version: _version, title, nodes, edges, steps, meta, ...topRest } = diagram;

  const outNodes = nodes.map((node): Rec => {
    const { kind, title: nTitle, subtitle, category, rows, source, ...rest } = node;
    const ext: Rec = Object.fromEntries(
      Object.entries({ kind, title: nTitle, subtitle, category, rows, source }).filter(([, v]) => v !== undefined),
    );
    const out: Rec = {
      ...rest,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
    };
    if (node.type === "text") {
      if (isRich(node)) {
        out.text = richMarkdown(node);
        ext.text = node.text ?? null; // original, restored on import
        ext.textHash = hashText(out.text as string);
      } else {
        out.text = node.text ?? ""; // JSON Canvas requires text on text nodes
      }
    }
    const preset = category ? CATEGORY_PRESET[resolveCategory(category) ?? ""] : undefined;
    if (!node.color && preset) {
      out.color = preset;
      ext.derivedColor = true;
    }
    if (Object.keys(ext).length) out[EXT_KEY] = ext;
    return out;
  });

  // JSON Canvas z-order is array order; keep groups underneath their children.
  outNodes.sort((a, b) => Number(b.type === "group") - Number(a.type === "group"));

  const outEdges = edges.map((edge): Rec => {
    const { style, ...rest } = edge;
    return style ? { ...rest, [EXT_KEY]: { style } } : { ...rest };
  });

  // A plain canvas stays plain: the document block is only written when it carries CodeMap-only data.
  // (A canvas title is its file name, so title alone is not worth a block.)
  const usesExtensions = steps !== undefined || meta !== undefined || [...outNodes, ...outEdges].some((x) => EXT_KEY in x);
  if (!usesExtensions) return { ...topRest, nodes: outNodes, edges: outEdges };
  const docExt: Rec = { version: 1, title };
  if (steps) docExt.steps = steps;
  if (meta) docExt.meta = meta;
  return { ...topRest, nodes: outNodes, edges: outEdges, [EXT_KEY]: docExt };
}

function importNode(raw: Rec, warnings: string[]): Rec {
  const { [EXT_KEY]: ext, ...node } = raw;
  if (!isRec(ext)) return node;

  const { text: originalText, textHash, derivedColor, ...fields } = ext;
  const restored: Rec = { ...node, ...fields };
  if (derivedColor === true) delete restored.color;

  if (!("text" in ext) || node.type !== "text") return restored;

  const original = str(originalText);
  const { text: current, title: _t, subtitle: _s, rows: _r, ...plain } = restored;
  // Files exported before textHash existed: recompute what the hash would have been.
  const expected = str(textHash) ?? hashText(richMarkdown(asRich(fields, original)));
  if (typeof current === "string" && hashText(current) === expected) {
    const { text: _generated, ...rest } = restored;
    return original === undefined ? rest : { ...rest, text: original };
  }

  const label = `Node "${String(node.id)}"`;
  const md = str(current) ?? "";
  const parsed = parseRichMarkdown(md, fields.kind === "table");
  if (parsed) {
    warnings.push(`${label}: edited outside CodeMap; title, subtitle, text and rows re-read from its markdown`);
    return { ...plain, ...parsed };
  }
  warnings.push(`${label}: edited outside CodeMap and no longer has a heading or list; kept as a plain note`);
  return { ...plain, kind: "note", text: md };
}

function importEdge(raw: Rec): Rec {
  const { [EXT_KEY]: ext, ...edge } = raw;
  return isRec(ext) && ext.style !== undefined ? { ...edge, style: ext.style } : edge;
}

/** Obsidian deletes edges with their node but never touches our steps: prune references that no longer resolve. */
function repairSteps(steps: unknown, nodeIds: Set<string>, edgeIds: Set<string>, warnings: string[]): unknown {
  if (!Array.isArray(steps)) return steps; // malformed: let the validator report it
  return steps.flatMap((s: unknown): unknown[] => {
    if (!isRec(s) || !Array.isArray(s.nodeIds)) return [s];
    const label = `Step "${String(s.title)}" (${String(s.id)})`;
    const prune = (ids: unknown[], known: Set<string>, what: string): unknown[] =>
      ids.filter((id) => {
        if (typeof id !== "string" || known.has(id)) return true;
        warnings.push(`${label}: removed missing ${what} ${id}`);
        return false;
      });
    const keptNodes = prune(s.nodeIds, nodeIds, "node");
    if (s.nodeIds.length > 0 && keptNodes.length === 0) {
      warnings.push(`${label}: dropped, none of its nodes remain`);
      return [];
    }
    const repaired: Rec = { ...s, nodeIds: keptNodes };
    if (Array.isArray(s.edgeIds)) repaired.edgeIds = prune(s.edgeIds, edgeIds, "edge");
    return [repaired];
  });
}

const idsOf = (items: unknown[]): Set<string> =>
  new Set(items.flatMap((x) => (isRec(x) && typeof x.id === "string" ? [x.id] : [])));

/**
 * Parses a `.canvas` file (already JSON-decoded). Unknown fields are kept on their node/edge/document.
 * Repairs (pruned step references, re-read edited nodes) are reported in `warnings`; anything else invalid is an error.
 */
export function fromJsonCanvas(input: unknown, opts: { title?: string } = {}): ImportResult {
  const fail = (e: string): ImportResult => ({ ok: false, errors: [e], warnings: [] });
  if (!isRec(input)) return fail("JSON Canvas must be a JSON object");
  const { nodes = [], edges = [], [EXT_KEY]: ext, ...topRest } = input;
  if (!Array.isArray(nodes)) return fail("nodes: must be an array");
  if (!Array.isArray(edges)) return fail("edges: must be an array");

  const warnings: string[] = [];
  const docExt = isRec(ext) ? ext : {};
  // Non-object entries are passed through untouched so the validator reports them by index.
  const outNodes = nodes.map((n: unknown) => (isRec(n) ? importNode(n, warnings) : n));
  const outEdges = edges.map((e: unknown) => (isRec(e) ? importEdge(e) : e));
  const candidate: Rec = {
    ...topRest,
    version: 1,
    title: str(docExt.title) ?? opts.title ?? "Untitled",
    nodes: outNodes,
    edges: outEdges,
  };
  if (docExt.steps !== undefined) candidate.steps = repairSteps(docExt.steps, idsOf(outNodes), idsOf(outEdges), warnings);
  if (docExt.meta !== undefined) candidate.meta = docExt.meta;
  const parsed = parseDiagram(candidate);
  return { ...parsed, warnings: [...warnings, ...parsed.warnings] };
}

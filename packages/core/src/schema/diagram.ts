import { z } from "zod";

// Every object is "loose": unknown fields survive parsing so nothing is lost on round-trip.

const id = z.string().min(1, "must be a non-empty string");

export const sideSchema = z.enum(["top", "right", "bottom", "left"]);
export const endSchema = z.enum(["none", "arrow"]);

export const colorSchema = z
  .string()
  .regex(
    /^([1-6]|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/,
    'must be a preset "1".."6" or a hex color like "#4f46e5"',
  );

export const nodeKindSchema = z.enum(["layer", "entity", "data", "table", "note", "start"]);

export const rowSchema = z.looseObject({
  text: z.string(),
  muted: z.boolean().optional(),
});

export const sourceRefSchema = z.looseObject({
  path: z.string().min(1, "must be a non-empty path"),
  line: z.number().int().positive().optional(),
});

export const diagramNodeSchema = z.looseObject({
  id,
  type: z.enum(["text", "group", "file", "link"]),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  color: colorSchema.optional(),
  text: z.string().optional(), // markdown, type "text"
  label: z.string().optional(), // type "group"
  background: z.string().optional(), // type "group": image path
  backgroundStyle: z.enum(["cover", "ratio", "repeat"]).optional(),
  file: z.string().optional(), // type "file" (required there)
  subpath: z.string().optional(),
  url: z.string().optional(), // type "link" (required there)
  // CodeMap extensions
  kind: nodeKindSchema.optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  category: z.string().min(1).optional(), // open set: CATEGORIES + CATEGORY_ALIASES; others warn and get a fallback color
  rows: z.array(rowSchema).optional(),
  source: sourceRefSchema.optional(),
});

export const diagramEdgeSchema = z.looseObject({
  id,
  fromNode: id,
  fromSide: sideSchema.optional(),
  fromEnd: endSchema.optional(),
  toNode: id,
  toSide: sideSchema.optional(),
  toEnd: endSchema.optional(),
  label: z.string().optional(),
  color: colorSchema.optional(),
  style: z.enum(["solid", "dashed"]).optional(),
});

export const walkthroughStepSchema = z.looseObject({
  id,
  title: z.string().min(1, "must be a non-empty string"),
  description: z.string(),
  nodeIds: z.array(id).min(1, "must highlight at least one node"),
  edgeIds: z.array(id).optional(),
});

export const diagramSchema = z
  .looseObject({
    version: z.literal(1, "must be 1"),
    title: z.string(),
    nodes: z.array(diagramNodeSchema),
    edges: z.array(diagramEdgeSchema),
    steps: z.array(walkthroughStepSchema).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message });
    };

    const nodeIds = new Set<string>();
    d.nodes.forEach((n, i) => {
      if (nodeIds.has(n.id)) issue(["nodes", i, "id"], `duplicate node id "${n.id}"`);
      nodeIds.add(n.id);
      if (n.type === "file" && !n.file) issue(["nodes", i, "file"], 'is required for type "file"');
      if (n.type === "link" && !n.url) issue(["nodes", i, "url"], 'is required for type "link"');
    });

    const edgeIds = new Set<string>();
    d.edges.forEach((e, i) => {
      if (edgeIds.has(e.id)) issue(["edges", i, "id"], `duplicate edge id "${e.id}"`);
      edgeIds.add(e.id);
      if (!nodeIds.has(e.fromNode)) issue(["edges", i, "fromNode"], `unknown node "${e.fromNode}"`);
      if (!nodeIds.has(e.toNode)) issue(["edges", i, "toNode"], `unknown node "${e.toNode}"`);
    });

    const stepIds = new Set<string>();
    d.steps?.forEach((s, i) => {
      if (stepIds.has(s.id)) issue(["steps", i, "id"], `duplicate step id "${s.id}"`);
      stepIds.add(s.id);
      s.nodeIds.forEach((nid, j) => {
        if (!nodeIds.has(nid)) issue(["steps", i, "nodeIds", j], `unknown node "${nid}"`);
      });
      s.edgeIds?.forEach((eid, j) => {
        if (!edgeIds.has(eid)) issue(["steps", i, "edgeIds", j], `unknown edge "${eid}"`);
      });
    });
  });

export type Diagram = z.infer<typeof diagramSchema>;
export type DiagramNode = z.infer<typeof diagramNodeSchema>;
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>;
export type WalkthroughStep = z.infer<typeof walkthroughStepSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type Side = z.infer<typeof sideSchema>;

export type ParseResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** The color families every theme defines. `category` is an open string; these are the ones with their own palette. */
export const CATEGORIES = ["layer", "entity", "db", "service", "data", "note", "warning"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Common synonyms (an LLM or a human will write "database" or "api"). Matched case-insensitively. */
export const CATEGORY_ALIASES: Readonly<Record<string, Category>> = {
  database: "db",
  table: "db",
  storage: "db",
  sql: "db",
  api: "service",
  backend: "service",
  svc: "service",
  controller: "layer",
  ui: "layer",
  frontend: "layer",
  model: "entity",
  domain: "entity",
  dto: "data",
  input: "data",
  payload: "data",
  info: "note",
  comment: "note",
  error: "warning",
  danger: "warning",
  risk: "warning",
};

/** Canonical family for a category, or undefined when unknown (renderers then pick a stable fallback color). */
export function resolveCategory(category: string): Category | undefined {
  const c = category.trim().toLowerCase();
  return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : CATEGORY_ALIASES[c];
}

function categoryWarnings(d: Diagram): string[] {
  const unknown = new Map<string, string[]>();
  for (const n of d.nodes) {
    if (n.category && !resolveCategory(n.category)) unknown.set(n.category, [...(unknown.get(n.category) ?? []), n.id]);
  }
  return [...unknown].map(
    ([c, ids]) =>
      `category "${c}" (${ids.join(", ")}) is not one of ${CATEGORIES.join(", ")} or a known alias; it gets a fallback color`,
  );
}

const KNOWN_KEYS = {
  diagram: new Set(Object.keys(diagramSchema.shape)),
  node: new Set(Object.keys(diagramNodeSchema.shape)),
  edge: new Set(Object.keys(diagramEdgeSchema.shape)),
  step: new Set(Object.keys(walkthroughStepSchema.shape)),
};

/**
 * Keys the schema doesn't know (outside `meta`). They are preserved, so this is for a dev-time warning:
 * a typo like `titel` or an LLM inventing fields. JSON Canvas plugin fields will show up here too.
 */
export function findUnknownKeys(d: Diagram): string[] {
  const out: string[] = [];
  const scan = (obj: object, known: Set<string>, path: string) => {
    for (const k of Object.keys(obj)) if (!known.has(k)) out.push(path ? `${path}.${k}` : k);
  };
  scan(d, KNOWN_KEYS.diagram, "");
  d.nodes.forEach((n) => scan(n, KNOWN_KEYS.node, `nodes[${n.id}]`));
  d.edges.forEach((e) => scan(e, KNOWN_KEYS.edge, `edges[${e.id}]`));
  d.steps?.forEach((s) => scan(s, KNOWN_KEYS.step, `steps[${s.id}]`));
  return out;
}

/** `nodes[3].width: Too small: expected number to be >0` — readable for humans and for LLM retries. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((iss) => {
    const path = iss.path
      .map((p, i) => (typeof p === "number" ? `[${p}]` : `${i === 0 ? "" : "."}${String(p)}`))
      .join("");
    return path ? `${path}: ${iss.message}` : iss.message;
  });
}

export function parseDiagram(input: unknown): ParseResult<Diagram> {
  const r = diagramSchema.safeParse(input);
  return r.success
    ? { ok: true, value: r.data, warnings: categoryWarnings(r.data) }
    : { ok: false, errors: formatIssues(r.error), warnings: [] };
}

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
  file: z.string().optional(), // type "file" (required there)
  subpath: z.string().optional(),
  url: z.string().optional(), // type "link" (required there)
  // CodeMap extensions
  kind: nodeKindSchema.optional(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  category: z.string().min(1).optional(), // open set; unknown values get a fallback color
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

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

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
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: formatIssues(r.error) };
}

import { z } from "zod";
import { codeGraphSchema } from "../graph/types";
import { diagramSchema, formatIssues, type ParseResult } from "../schema/diagram";

/**
 * Webview <-> VS Code extension protocol. Requests go webview -> extension and get exactly one response;
 * events go extension -> webview. Both sides validate every message with these schemas: the webview is
 * untrusted from the extension's point of view (it renders file contents), and vice versa.
 */

export const themeSchema = z.enum(["light", "dark"]);
export type ThemeName = z.infer<typeof themeSchema>;

const id = z.string().min(1);
const none = z.null();

/** Every request the webview can make: its params and the shape of its result. */
export const methods = {
  /** First call after load: which UI to show. */
  init: {
    params: z.object({}),
    // native: follow the host's own colors (VS Code theme) instead of Tracer's light/dark palette.
    result: z.object({ mode: z.enum(["editor", "graph"]), documentId: id.optional(), theme: themeSchema, native: z.boolean() }),
  },
  loadDiagram: { params: z.object({ id }), result: diagramSchema },
  /** Explicit save (toolbar). In the custom editor this writes the document and saves it. */
  saveDiagram: { params: z.object({ id, diagram: diagramSchema }), result: none },
  /** Custom editor: one committed change. The extension applies it to the TextDocument (VS Code owns undo). */
  applyEdit: { params: z.object({ id, diagram: diagramSchema }), result: none },
  runCommand: { params: z.object({ name: z.enum(["undo", "redo"]) }), result: none },
  loadGraph: { params: z.object({}), result: codeGraphSchema },
  openSource: { params: z.object({ path: id, line: z.number().int().positive().optional() }), result: none },
  listDiagrams: { params: z.object({}), result: z.array(z.object({ id, title: z.string() })) },
  exportFile: {
    params: z.object({
      // A suggested file name only (the user picks the folder in a save dialog): no paths.
      filename: id.regex(/^[^/\\:*?"<>|]+$/, "must be a plain file name"),
      data: z.string(),
      encoding: z.enum(["utf8", "base64"]),
    }),
    result: none,
  },
  /** The webview reports whether a document rendered, so the extension can surface errors (and tests can wait on it). */
  reportStatus: {
    params: z.object({ id, state: z.enum(["loaded", "error"]), nodeCount: z.number().int().nonnegative().optional(), detail: z.string().optional() }),
    result: none,
  },
} as const;

export type Method = keyof typeof methods;
export const METHODS = Object.keys(methods) as Method[];
export type Params<M extends Method> = z.infer<(typeof methods)[M]["params"]>;
export type Result<M extends Method> = z.infer<(typeof methods)[M]["result"]>;

export type Request = { [M in Method]: { kind: "request"; id: number; method: M; params: Params<M> } }[Method];

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ kind: z.literal("response"), id: z.number().int().nonnegative(), ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ kind: z.literal("response"), id: z.number().int().nonnegative(), ok: z.literal(false), error: z.string() }),
]);
export type Response = z.infer<typeof responseSchema>;

const eventSchema = z.discriminatedUnion("type", [
  z.object({ kind: z.literal("event"), type: z.literal("theme"), theme: themeSchema, native: z.boolean() }),
  /** The document changed outside the webview: undo/redo, another editor, an Obsidian save on disk. */
  z.object({ kind: z.literal("event"), type: z.literal("documentChanged"), id, diagram: diagramSchema }),
  /** The document on disk/in the editor no longer parses; the webview shows the errors instead of the canvas. */
  z.object({ kind: z.literal("event"), type: z.literal("documentInvalid"), id, errors: z.array(z.string()) }),
]);
export type HostEvent = z.infer<typeof eventSchema>;
export type ToWebview = Response | HostEvent;

const envelope = z.object({
  kind: z.literal("request"),
  id: z.number().int().nonnegative(),
  method: z.enum(METHODS as [Method, ...Method[]]),
  params: z.unknown().optional(),
});

const fail = <T>(errors: string[]): ParseResult<T> => ({ ok: false, errors, warnings: [] });

/** Extension side: validates a message from the webview. */
export function parseToHost(raw: unknown): ParseResult<Request> {
  const e = envelope.safeParse(raw);
  if (!e.success) return fail(formatIssues(e.error));
  const p = methods[e.data.method].params.safeParse(e.data.params ?? {});
  if (!p.success) return fail(formatIssues(p.error).map((m) => `params.${m}`));
  return { ok: true, value: { ...e.data, params: p.data } as Request, warnings: [] };
}

/** Webview side: validates a message from the extension (a response's `result` is checked by `parseResult`). */
export function parseToWebview(raw: unknown): ParseResult<ToWebview> {
  const r = z.union([responseSchema, eventSchema]).safeParse(raw);
  return r.success ? { ok: true, value: r.data, warnings: [] } : fail(formatIssues(r.error));
}

/** Webview side: validates the result of a successful response against the method it answers. */
export function parseResult<M extends Method>(method: M, raw: unknown): ParseResult<Result<M>> {
  const r = methods[method].result.safeParse(raw);
  return r.success ? { ok: true, value: r.data as Result<M>, warnings: [] } : fail(formatIssues(r.error).map((m) => `result.${m}`));
}

/** Extension side: builds outgoing messages, validated before they leave (a bug here should fail loudly, not in the UI). */
export function okResponse<M extends Method>(id: number, method: M, result: Result<M>): Response {
  return responseSchema.parse({ kind: "response", id, ok: true, result: methods[method].result.parse(result) });
}
export const errorResponse = (id: number, error: string): Response => responseSchema.parse({ kind: "response", id, ok: false, error });
export const hostEvent = (event: HostEvent): HostEvent => eventSchema.parse(event);

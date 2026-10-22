import { z } from "zod";

// Output of the analyzer (`npm run analyze`). Paths are relative to the analyzed root, with forward slashes.

export const codeGraphNodeSchema = z.object({
  id: z.string().min(1), // same as path
  path: z.string().min(1),
  folder: z.string(), // "." for files at the root
  ext: z.string(),
  loc: z.number().int().nonnegative(),
  inDegree: z.number().int().nonnegative(),
  outDegree: z.number().int().nonnegative(),
});

export const codeGraphEdgeSchema = z.object({ source: z.string(), target: z.string() });

export const codeGraphSummarySchema = z.object({
  fileCount: z.number().int(),
  skippedCount: z.number().int(),
  edgeCount: z.number().int(),
  unresolvedCount: z.number().int(), // relative or alias imports that point nowhere
  externalCount: z.number().int(), // package/builtin imports ("react", "node:fs")
  cycleCount: z.number().int(), // strongly connected components with more than one file
  unresolved: z.array(z.object({ from: z.string(), specifier: z.string() })),
  warnings: z.array(z.string()),
});

export const codeGraphSchema = z.object({
  version: z.literal(1),
  root: z.string(), // folder name only: no absolute paths in a file that gets committed or shared
  nodes: z.array(codeGraphNodeSchema),
  edges: z.array(codeGraphEdgeSchema),
  summary: codeGraphSummarySchema,
});

export type CodeGraphNode = z.infer<typeof codeGraphNodeSchema>;
export type CodeGraphEdge = z.infer<typeof codeGraphEdgeSchema>;
export type CodeGraphSummary = z.infer<typeof codeGraphSummarySchema>;
export type CodeGraph = z.infer<typeof codeGraphSchema>;

// Output of the Phase 2 analyzer. Paths use forward slashes, relative to the analyzed root.
export type CodeGraphNode = {
  id: string;
  path: string;
  folder: string;
  ext: string;
  loc: number;
  inDegree: number;
  outDegree: number;
};

export type CodeGraphEdge = { source: string; target: string };

export type CodeGraph = {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  summary?: { root: string; fileCount: number; edgeCount: number; unresolvedCount: number; warnings: string[] };
};

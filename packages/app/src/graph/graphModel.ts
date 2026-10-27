import { isTestFile, localGraph, type CodeGraph, type CodeGraphNode } from "@tracer/core";

export type GraphFilters = {
  hideOrphans: boolean;
  hideTests: boolean;
  hiddenGroups: ReadonlySet<string>;
  /** Local graph mode: only `id` and its neighbors up to `depth` hops. */
  local: { id: string; depth: number } | null;
};

export const defaultFilters: GraphFilters = { hideOrphans: false, hideTests: false, hiddenGroups: new Set(), local: null };

/**
 * Color/filter group of a file: its top-level folder, measured below the folder every file shares.
 * (A repo whose code all lives in `src/` would otherwise be one color.) In a monorepo, the first two
 * levels (`packages/app`), so each package gets its own color. Files above that depth are "(root)" or
 * their single folder.
 */
export function groupResolver(paths: readonly string[], monorepo = false): (path: string) => string {
  // Root-level files (README.md, docker-compose.yml, …) have no folder and so no opinion on the shared
  // prefix; counting them would collapse it to 0 for any repo that has one, which is nearly all of them.
  const dirs = paths.map((p) => p.split("/").slice(0, -1)).filter((d) => d.length);
  let common = 0;
  if (dirs.length) {
    const first = dirs[0] ?? [];
    while (common < first.length && dirs.every((d) => d[common] === first[common])) common++;
  }
  return (path) => {
    const dirs = path.split("/").slice(common, -1); // folders below the shared prefix
    if (!dirs.length) return "(root)";
    return monorepo && dirs.length >= 2 ? `${dirs[0]}/${dirs[1]}` : (dirs[0] ?? "(root)");
  };
}

export function visibleNodeIds(graph: CodeGraph, f: GraphFilters, groupOf: (path: string) => string): Set<string> {
  const local = f.local ? localGraph(f.local.id, graph.edges, f.local.depth) : null;
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (local && !local.has(n.id)) continue;
    if (f.local?.id === n.id) {
      ids.add(n.id); // the focus of a local graph always stays visible
      continue;
    }
    if (f.hideOrphans && n.inDegree + n.outDegree === 0) continue;
    if (f.hideTests && isTestFile(n.path)) continue;
    if (f.hiddenGroups.has(groupOf(n.path))) continue;
    ids.add(n.id);
  }
  return ids;
}

/** Case-insensitive path substring. Empty query matches nothing (no highlight). */
export function searchMatches(nodes: readonly CodeGraphNode[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? nodes.filter((n) => n.path.toLowerCase().includes(q)).map((n) => n.id) : [];
}

/** Stable color index per group: groups sorted by name, so colors don't shuffle between runs. */
export function groupColors(groups: Iterable<string>, palette: readonly string[]): Map<string, string> {
  return new Map([...new Set(groups)].sort().map((g, i) => [g, palette[i % palette.length] ?? "#888"]));
}

export function neighborsOf(graph: CodeGraph, id: string): { imports: string[]; importedBy: string[] } {
  return {
    imports: graph.edges.filter((e) => e.source === id).map((e) => e.target),
    importedBy: graph.edges.filter((e) => e.target === id).map((e) => e.source),
  };
}

import { layoutFlow } from "../layout/flowLayout";
import type { Diagram, DiagramEdge, DiagramNode } from "../schema/diagram";
import type { CodeGraph, CodeGraphNode } from "./types";

/**
 * The workspace map: folders and files as an expandable tree, with the imports between whatever is visible
 * rolled up (a collapsed folder stands for everything inside it). Pure: the app keeps the expand state and
 * asks for a new diagram when it changes.
 */

export type MapState = {
  /** Folders (by map id, `d:<path>`) that show their children. The workspace root is `d:`. */
  expanded: ReadonlySet<string>;
  /** Extra pages of children revealed per folder (`d:<path>` -> pages beyond the first). */
  pages: ReadonlyMap<string, number>;
};

export type MapItem = { kind: "dir" | "file" | "more"; path: string };
export type MapResult = { diagram: Diagram; items: ReadonlyMap<string, MapItem>; counts: { folders: number; files: number; imports: number } };

export const PAGE_SIZE = 30;
const MAX_IMPORT_EDGES = 250;
const CATEGORIES = ["layer", "service", "db", "entity", "data", "warning", "note"] as const;
const LOW_COVERAGE_PCT = 50; // a loaded coverage report (applyCoverage): below this, the file's card tints "warning"

type Dir = {
  id: string;
  path: string;
  name: string;
  parent?: Dir;
  dirs: Dir[];
  files: CodeGraphNode[];
  fileCount: number; // all files below
  langs: Map<string, number>;
  service?: string; // build system when this folder holds a manifest
  tint: string;
};

const fileId = (p: string): string => `f:${p}`;
const dirId = (p: string): string => `d:${p}`;
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function buildTree(graph: CodeGraph): Dir {
  const services = new Map((graph.services ?? []).map((s) => [s.path, s.kind]));
  const make = (path: string, name: string, parent?: Dir): Dir => ({
    id: dirId(path), path, name, parent, dirs: [], files: [], fileCount: 0, langs: new Map(), service: services.get(path), tint: "note",
  });
  const root = make("", graph.root || "workspace");
  const dirs = new Map<string, Dir>([["", root]]);
  const dirFor = (path: string): Dir => {
    const known = dirs.get(path);
    if (known) return known;
    const parent = dirFor(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    const d = make(path, base(path), parent);
    parent.dirs.push(d);
    dirs.set(path, d);
    return d;
  };
  for (const n of graph.nodes) {
    const d = dirFor(n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "");
    d.files.push(n);
    for (let a: Dir | undefined = d; a; a = a.parent) {
      a.fileCount++;
      if (n.lang) a.langs.set(n.lang, (a.langs.get(n.lang) ?? 0) + 1);
    }
  }
  // Collapse chains of single-child folders (src/main/java/com/acme -> one card) unless they hold a service.
  const compress = (d: Dir): void => {
    for (let i = 0; i < d.dirs.length; i++) {
      let c = d.dirs[i] as Dir;
      while (c.dirs.length === 1 && c.files.length === 0 && !c.service) {
        const only = c.dirs[0] as Dir;
        only.name = `${c.name}/${only.name}`;
        only.parent = d;
        c = only;
      }
      d.dirs[i] = c;
      compress(c);
    }
  };
  compress(root);
  // One colour per top-level branch; everything inside inherits it.
  root.dirs
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((d, i) => {
      const tint = CATEGORIES[i % CATEGORIES.length] as string;
      const paint = (x: Dir): void => {
        x.tint = tint;
        x.dirs.forEach(paint);
      };
      paint(d);
    });
  return root;
}

/**
 * What to show when the map first opens: the workspace, then the largest folders opened one by one until
 * about ten cards are visible (so a repo whose code all lives in `src/` does not open on a lone card).
 */
export function initialMapState(graph: CodeGraph): MapState {
  const root = buildTree(graph);
  const expanded = new Set([root.id]);
  const shown = (d: Dir): number => 1 + (expanded.has(d.id) ? d.files.length + d.dirs.reduce((n, c) => n + shown(c), 0) : 0);
  for (let guard = 0; guard < 20 && shown(root) < 10; guard++) {
    const next = collapsedDirs(root, expanded).sort((x, y) => y.fileCount - x.fileCount)[0];
    if (!next) break;
    expanded.add(next.id);
  }
  return { expanded, pages: new Map() };
}

function collapsedDirs(d: Dir, expanded: ReadonlySet<string>): Dir[] {
  if (!expanded.has(d.id)) return [];
  return d.dirs.flatMap((c) => (expanded.has(c.id) ? collapsedDirs(c, expanded) : c.dirs.length + c.files.length ? [c] : []));
}

const sortedDirs = (d: Dir): Dir[] => [...d.dirs].sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
const sortedFiles = (d: Dir): CodeGraphNode[] => [...d.files].sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || a.path.localeCompare(b.path));

export function buildMap(graph: CodeGraph, state: MapState): MapResult {
  const root = buildTree(graph);
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const items = new Map<string, MapItem>();
  const shownFile = new Set<string>(); // file path -> drawn as its own card
  const shownDir = new Map<string, Dir>();
  const rows = (d: Dir) => [...d.langs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, n]) => ({ text: `${n} ${l}` }));

  const addDir = (d: Dir, isRoot: boolean): void => {
    const open = state.expanded.has(d.id);
    const items_ = d.dirs.length + d.files.length;
    nodes.push({
      id: d.id, type: "text", x: 0, y: 0, width: 248, height: 46 + 20 + 18 * rows(d).length,
      kind: isRoot || d.service ? "layer" : "entity",
      category: d.tint,
      title: d.name,
      subtitle: `${items_ ? (open ? "▾" : "▸") : "·"} ${d.fileCount} file${d.fileCount === 1 ? "" : "s"}${d.service ? ` · ${d.service}` : ""}`,
      rows: rows(d),
    });
    items.set(d.id, { kind: "dir", path: d.path });
    shownDir.set(d.id, d);
  };
  const contain = (from: string, to: string): void => {
    edges.push({ id: `c${edges.length + 1}`, fromNode: from, toNode: to, style: "dashed", toEnd: "none" });
  };

  const walk = (d: Dir, isRoot: boolean): void => {
    addDir(d, isRoot);
    if (!state.expanded.has(d.id)) return;
    const pages = 1 + (state.pages.get(d.id) ?? 0);
    const limit = pages * PAGE_SIZE;
    let drawn = 0;
    for (const c of sortedDirs(d)) {
      if (drawn >= limit) break;
      contain(d.id, c.id);
      walk(c, false);
      drawn++;
    }
    for (const f of sortedFiles(d)) {
      if (drawn >= limit) break;
      const pct = f.coverage ? Math.round((100 * f.coverage.linesCovered) / f.coverage.linesTotal) : undefined;
      const lowCoverage = pct !== undefined && pct < LOW_COVERAGE_PCT;
      nodes.push({
        id: fileId(f.path), type: "text", x: 0, y: 0, width: 216, height: 58, kind: "note", category: lowCoverage ? "warning" : d.tint,
        title: base(f.path),
        subtitle: `${f.loc} lines · ↓${f.inDegree} ↑${f.outDegree}${pct === undefined ? "" : ` · ${pct}% covered`}`,
        source: { path: f.path },
      });
      items.set(fileId(f.path), { kind: "file", path: f.path });
      shownFile.add(f.path);
      contain(d.id, fileId(f.path));
      drawn++;
    }
    const hidden = d.dirs.length + d.files.length - drawn;
    if (hidden > 0) {
      const id = `m:${d.path}`;
      nodes.push({ id, type: "text", x: 0, y: 0, width: 216, height: 52, kind: "note", category: "note", title: `+ ${hidden} more`, subtitle: `click to show ${Math.min(PAGE_SIZE, hidden)} more` });
      items.set(id, { kind: "more", path: d.path });
      contain(d.id, id);
    }
  };
  walk(root, true);

  // Imports between whatever is visible: a file stands for itself, anything hidden for its nearest visible folder.
  const dirOfFile = new Map<string, Dir>();
  const index = (d: Dir): void => {
    for (const f of d.files) dirOfFile.set(f.path, d);
    d.dirs.forEach(index);
  };
  index(root);
  const rep = (path: string): string | undefined => {
    if (shownFile.has(path)) return fileId(path);
    for (let d: Dir | undefined = dirOfFile.get(path); d; d = d.parent) if (shownDir.has(d.id)) return d.id;
    return undefined;
  };
  const isInside = (inner: string, outer: string): boolean => {
    const o = shownDir.get(outer);
    if (!o) return false;
    const startDir = inner.startsWith("d:") ? shownDir.get(inner) : dirOfFile.get(inner.slice(2));
    for (let d = startDir; d; d = d.parent) if (d.id === outer) return true;
    return false;
  };
  const weights = new Map<string, number>();
  for (const e of graph.edges) {
    const a = rep(e.source);
    const b = rep(e.target);
    if (!a || !b || a === b || isInside(a, b) || isInside(b, a)) continue;
    const key = `${a}\u0000${b}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const imports = [...weights].sort((x, y) => y[1] - x[1]).slice(0, MAX_IMPORT_EDGES);
  for (const [key, count] of imports) {
    const [from, to] = key.split("\u0000") as [string, string];
    edges.push({ id: `i${edges.length + 1}`, fromNode: from, toNode: to, ...(count > 1 ? { label: `${count}` } : {}) });
  }

  layoutFlow(nodes, edges, { nodeGap: 36, rankGap: 80 });
  return {
    diagram: { version: 1, title: graph.root || "workspace", nodes, edges, meta: { generated: { by: "tracer", scope: "map" } } },
    items,
    counts: { folders: shownDir.size, files: shownFile.size, imports: imports.length },
  };
}

/** The state after clicking item `id`: folders toggle, "more" reveals the next page. */
export function activateMapItem(state: MapState, id: string, item: MapItem): MapState {
  if (item.kind === "dir") {
    const expanded = new Set(state.expanded);
    if (!expanded.delete(id)) expanded.add(id);
    return { expanded, pages: state.pages };
  }
  if (item.kind === "more") {
    const key = dirId(item.path);
    return { expanded: state.expanded, pages: new Map(state.pages).set(key, (state.pages.get(key) ?? 0) + 1) };
  }
  return state;
}

/** Opens every folder on the way to `path` (and pages far enough) so that file is a visible card. */
export function revealInMap(graph: CodeGraph, state: MapState, path: string): MapState {
  const root = buildTree(graph);
  const file = graph.nodes.find((n) => n.path === path);
  if (!file) return state;
  const expanded = new Set(state.expanded);
  const pages = new Map(state.pages);
  const find = (d: Dir): Dir | undefined => (d.files.some((f) => f.path === path) ? d : d.dirs.map(find).find(Boolean));
  const home = find(root);
  if (!home) return state;
  const chain: Dir[] = [];
  for (let d: Dir | undefined = home; d; d = d.parent) chain.unshift(d);
  for (const d of chain) {
    expanded.add(d.id);
    const parent = d.parent;
    if (parent) {
      const at = sortedDirs(parent).indexOf(d);
      pages.set(parent.id, Math.max(pages.get(parent.id) ?? 0, Math.floor(at / PAGE_SIZE)));
    }
  }
  const at = home.dirs.length + sortedFiles(home).findIndex((f) => f.path === path);
  pages.set(home.id, Math.max(pages.get(home.id) ?? 0, Math.floor(at / PAGE_SIZE)));
  return { expanded, pages };
}

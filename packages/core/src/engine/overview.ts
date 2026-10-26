import { layoutFlow } from "../layout/flowLayout";
import type { Diagram, DiagramEdge, DiagramNode } from "../schema/diagram";
import type { FileFacts } from "./facts";
import { NODE_W, type CallResolver, type CallTarget } from "./flow";

export type IndexedFile = { path: string; facts: FileFacts; service: string };
type Fn = { path: string; name: string; container?: string; line: number; endLine: number; calls: string[]; service: string };

export type FunctionIndex = {
  resolve: CallResolver;
  /** The innermost function of `path` that contains `line`. */
  functionAt(path: string, line: number): Fn | undefined;
  has(path: string): boolean;
  /** The function a resolved call points at (undefined for a type constructor or an unknown target). */
  definition(t: CallTarget): Fn | undefined;
};

const COMMON = new Set([
  "get", "set", "add", "put", "remove", "delete", "size", "length", "count", "map", "filter", "forEach", "push", "pop", "log", "print", "println",
  "toString", "equals", "hashCode", "close", "open", "init", "run", "apply", "call", "next", "of", "from", "new", "format", "parse", "append", "join", "split",
]);
const SELF = /^(this|self|super|\$this|base|me)$/;
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Index of every function and type in the workspace, with a heuristic (name + receiver) call resolver. */
export function buildFunctionIndex(files: Iterable<IndexedFile>): FunctionIndex {
  const byPath = new Map<string, IndexedFile>();
  const byName = new Map<string, Fn[]>();
  const types = new Map<string, Fn[]>();
  const push = (m: Map<string, Fn[]>, k: string, f: Fn) => {
    const list = m.get(k);
    if (list) list.push(f);
    else m.set(k, [f]);
  };
  for (const f of files) {
    byPath.set(f.path, f);
    for (const fn of f.facts.functions) push(byName, fn.name, { ...fn, path: f.path, service: f.service });
    for (const t of f.facts.types) push(types, t.name, { path: f.path, name: t.name, line: t.line, endLine: t.line, calls: [], service: f.service });
  }

  const pick = (cands: Fn[], from: { path: string; container?: string }, service: string | undefined, receiver: string): Fn | undefined => {
    if (!cands.length) return undefined;
    if (receiver) {
      const r = alnum(receiver);
      const byContainer = r.length >= 2 ? cands.filter((c) => c.container && alnum(c.container).includes(r)) : [];
      const pool = byContainer.length ? byContainer : [];
      if (pool.length) return narrow(pool, from, service);
    }
    if (receiver && COMMON.has(cands[0]?.name ?? "")) return undefined; // `x.get()` on an unknown receiver: could be anything
    return narrow(cands, from, service, !receiver);
  };
  // Prefer the caller's own file, then its service; accept only an unambiguous result.
  const narrow = (cands: Fn[], from: { path: string; container?: string }, service: string | undefined, preferContainer = false): Fn | undefined => {
    const same = cands.filter((c) => c.path === from.path);
    const pool = same.length ? same : cands.filter((c) => c.service === service).length ? cands.filter((c) => c.service === service) : cands;
    const own = preferContainer ? pool.filter((c) => c.container === from.container) : [];
    const finalPool = own.length ? own : pool;
    return finalPool.length === 1 ? finalPool[0] : undefined;
  };

  const resolve: CallResolver = (callee, from) => {
    const isNew = /^new\s+/.test(callee);
    const parts = callee.replace(/^new\s+/, "").split(/\.|::|->/).map((p) => p.replace(/[!?$]/g, "").trim()).filter(Boolean);
    while (parts.length > 1 && SELF.test(parts[0] ?? "")) parts.shift();
    const name = parts.at(-1);
    if (!name) return undefined;
    const receiver = parts.length > 1 ? (parts.at(-2) ?? "").replace(/^(_|m_)/, "") : "";
    const service = byPath.get(from.path)?.service;
    const asTarget = (f: Fn | undefined): CallTarget | undefined => f && { path: f.path, line: f.line, name: f.name, container: f.container };
    if (isNew) return asTarget(narrow(types.get(name) ?? [], from, service));
    // `Order.of(...)`, `Svc::new()`: a capitalized receiver is usually the type itself.
    return asTarget(pick(byName.get(name) ?? [], from, service, receiver));
  };

  return {
    resolve,
    has: (path) => byPath.has(path),
    definition(t) {
      const f = byPath.get(t.path)?.facts.functions.find((fn) => fn.line === t.line && fn.name === t.name);
      return f && { ...f, path: t.path, service: byPath.get(t.path)?.service ?? "" };
    },
    functionAt(path, line) {
      const f = byPath.get(path);
      if (!f) return undefined;
      const inside = f.facts.functions.filter((fn) => fn.line <= line && line <= fn.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
      return inside && { ...inside, path, service: f.service };
    },
  };
}

/** Rough architectural role of a function from its class/file name; drives the card color. */
export function roleOf(container: string | undefined, path: string): string {
  const s = `${container ?? ""} ${path.slice(path.lastIndexOf("/") + 1)}`;
  if (/controller|handler|route|resource|endpoint|view|page|screen|command|cli/i.test(s)) return "layer";
  if (/repo|dao|store|mapper|gateway|client|database|\bdb\b|storage|persist/i.test(s)) return "db";
  if (/service|usecase|manager|processor|facade|worker|job|engine/i.test(s)) return "service";
  if (/model|entity|dto|record|schema|domain|type/i.test(s)) return "data";
  return "note";
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const nameOfFn = (f: { name: string; container?: string }): string => (f.container ? `${f.container}.${f.name}` : f.name);
const rowHeight = (rows: number): number => 46 + 20 + 18 * rows;

function card(id: string, fn: Fn, rows: string[], extra: Partial<DiagramNode> = {}): DiagramNode {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    width: NODE_W,
    height: rowHeight(rows.length),
    kind: "layer",
    category: roleOf(fn.container, fn.path),
    title: nameOfFn(fn),
    subtitle: `${base(fn.path)}:${fn.line}`,
    rows: rows.map((text) => ({ text })),
    source: { path: fn.path, line: fn.line },
    ...extra,
  };
}

const keyOf = (f: { path: string; line: number; name: string }): string => `${f.path}:${f.line}:${f.name}`; // name: C# accessors share a line
const MAX_ROWS = 5;

const MAX_OVERVIEW_FUNCTIONS = 60; // a 15,000-line file can declare 2,000: past this the overview is unreadable (and slow)
const MAX_OVERVIEW_TYPES = 20;

/**
 * How the functions of one file relate: who calls whom inside it, and what it reaches in other files.
 * A very large file shows its first functions and says how many more there are (`truncated`).
 */
export function fileOverview(file: IndexedFile, index: FunctionIndex): { ok: true; diagram: Diagram; truncated: boolean } | { ok: false; reason: string } {
  const all: Fn[] = file.facts.functions.map((f) => ({ ...f, path: file.path, service: file.service }));
  if (!all.length && !file.facts.types.length) return { ok: false, reason: `${base(file.path)} declares no functions or types.` };
  const fns = all.slice(0, MAX_OVERVIEW_FUNCTIONS);
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const ids = new Map<string, string>(); // function key -> node id
  const nextId = (p: string) => `${p}${nodes.length + 1}`;
  const linked = new Set<string>();
  const addEdge = (from: string, to: string, extra: Partial<DiagramEdge> = {}) => {
    if (from === to || linked.has(`${from}>${to}`)) return;
    linked.add(`${from}>${to}`);
    edges.push({ id: `e${edges.length + 1}`, fromNode: from, toNode: to, ...extra });
  };

  if (file.facts.imports.length) {
    const rows = file.facts.imports.slice(0, 8).map((i) => ({ text: i.replace(/^(path|rel|lib|mod):/, "") }));
    if (file.facts.imports.length > 8) rows.push({ text: `… ${file.facts.imports.length - 8} more` });
    nodes.push({ id: "imports", type: "text", x: 0, y: 0, width: NODE_W, height: 46 + 18 * rows.length, kind: "note", category: "note", title: "Imports", rows });
  }
  for (const f of fns) {
    const id = nextId("f");
    ids.set(keyOf(f), id);
    nodes.push(card(id, f, f.calls.slice(0, MAX_ROWS).map((c) => `${c}()`)));
  }
  const external = new Map<string, string>();
  for (const f of fns) {
    const from = ids.get(keyOf(f));
    if (!from) continue;
    for (const call of f.calls) {
      const t = index.resolve(call, { path: file.path, container: f.container });
      if (!t) continue;
      if (t.path === file.path) {
        const to = ids.get(keyOf(t));
        if (to) addEdge(from, to);
      } else if (external.size < 14 || external.has(keyOf(t))) {
        let to = external.get(keyOf(t));
        if (!to) {
          to = nextId("x");
          external.set(keyOf(t), to);
          const target: Fn = { ...t, endLine: t.line, calls: [], service: "" };
          nodes.push(card(to, target, [], { kind: "note", rows: undefined, height: 60, subtitle: `${t.path}:${t.line}` }));
        }
        addEdge(from, to, { style: "dashed" });
      }
    }
  }
  const containers = new Set(all.map((f) => f.container));
  const typesWithoutMethods = file.facts.types.filter((t) => !containers.has(t.name));
  for (const t of typesWithoutMethods.slice(0, MAX_OVERVIEW_TYPES)) {
    nodes.push({ id: nextId("t"), type: "text", x: 0, y: 0, width: NODE_W, height: 60, kind: "entity", category: "data", title: t.name, subtitle: `${t.kind} · line ${t.line}`, source: { path: file.path, line: t.line } });
  }
  const hidden = all.length - fns.length + Math.max(0, typesWithoutMethods.length - MAX_OVERVIEW_TYPES);
  if (hidden > 0) {
    const last = fns.at(-1);
    nodes.push({
      id: "more", type: "text", x: 0, y: 0, width: NODE_W, height: 72, kind: "note", category: "note",
      title: `${hidden} more not shown`,
      text: `From line ${(last?.endLine ?? 0) + 1}. Put the cursor in a function and run Show Flow to see it.`,
      source: last ? { path: file.path, line: last.endLine + 1 } : undefined,
    });
  }
  layoutFlow(nodes, edges);
  return { ok: true, truncated: hidden > 0, diagram: { version: 1, title: base(file.path), nodes, edges, meta: { generated: { by: "tracer", path: file.path, scope: "file" } } } };
}

/** The functions reachable from `start` through resolved calls, across files, up to `depth` hops. */
export function callTrace(index: FunctionIndex, start: { path: string; line: number }, depth = 4): { ok: true; diagram: Diagram; truncated: boolean } | { ok: false; reason: string } {
  const root = index.functionAt(start.path, start.line);
  if (!root) return { ok: false, reason: "There is no function at the cursor. Click inside a function and try again." };
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const seen = new Map<string, string>();
  let truncated = false;
  const MAX = 40;
  const add = (fn: Fn, level: number): string | undefined => {
    const k = keyOf(fn);
    const known = seen.get(k);
    if (known) return known;
    if (nodes.length >= MAX) {
      truncated = true;
      return undefined;
    }
    const id = `f${nodes.length + 1}`;
    seen.set(k, id);
    nodes.push(card(id, fn, [], level === 0 ? { kind: "start" } : {}));
    return id;
  };
  const queue: { fn: Fn; level: number }[] = [{ fn: root, level: 0 }];
  add(root, 0);
  while (queue.length) {
    const { fn, level } = queue.shift() as { fn: Fn; level: number };
    const from = seen.get(keyOf(fn));
    if (!from) continue;
    const unresolved: string[] = [];
    for (const call of fn.calls) {
      const t = index.resolve(call, { path: fn.path, container: fn.container });
      const def = t && index.definition(t);
      if (!def) {
        unresolved.push(call);
        continue;
      }
      if (level >= depth) continue;
      const known = seen.has(keyOf(def));
      const to = add(def, level + 1);
      if (to && !edges.some((e) => e.fromNode === from && e.toNode === to)) edges.push({ id: `e${edges.length + 1}`, fromNode: from, toNode: to });
      if (!known && to) queue.push({ fn: def, level: level + 1 });
    }
    const node = nodes.find((n) => n.id === from);
    if (node && unresolved.length) {
      node.rows = unresolved.slice(0, 3).map((text) => ({ text: `${text}()`, muted: true }));
      node.height = rowHeight(node.rows.length);
    }
  }
  layoutFlow(nodes, edges);
  return {
    ok: true,
    truncated,
    diagram: { version: 1, title: `Calls from ${nameOfFn(root)}`, nodes, edges, meta: { generated: { by: "tracer", path: start.path, scope: `trace depth ${depth}` } } },
  };
}

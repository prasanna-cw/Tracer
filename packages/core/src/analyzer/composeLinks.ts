import type { CodeGraphEdge, CodeGraphNode } from "../graph/types";
import type { FileSystemHost } from "./fileSystem";
import type { Service } from "./linkFacts";

export type ComposeLinkOutput = { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] };

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}
const join = (...parts: string[]): string => normalize(parts.filter(Boolean).join("/"));
function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** One indentation-nested key: value (or list item), with its children at a deeper indent. */
export type IndentNode = { key: string; value: string; indent: number; children: IndentNode[] };

/**
 * A generic reader for YAML's indentation structure only: mapping keys (`key: value`) and list items
 * (`- value`, `- key: value`) become nodes nested by indent depth. No anchors/aliases, no flow style
 * (`{a: b}`, `[a, b]` is kept as a literal string value, read separately), no multi-document files.
 */
export function parseIndentedTree(text: string): IndentNode[] {
  const root: IndentNode[] = [];
  const stack: IndentNode[] = []; // ancestors, outermost first
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const content = line.trim();
    if (!content || content.startsWith("#") || content === "---") continue;
    const indent = line.length - line.trimStart().length;
    const listItem = /^-\s*(.*)$/.exec(content);
    const effective = listItem ? (listItem[1] ?? "") : content;
    if (!effective) continue; // a bare "-" (empty list item): nothing to record
    const m = /^([^:]+):\s*(.*)$/.exec(effective);
    const node: IndentNode = {
      key: m ? (m[1] as string).trim() : effective,
      value: m ? (m[2] ?? "").trim().replace(/^["']|["']$/g, "") : "",
      indent,
      children: [],
    };
    while (stack.length && (stack[stack.length - 1] as IndentNode).indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.children : root).push(node);
    stack.push(node);
  }
  return root;
}

const child = (nodes: readonly IndentNode[], key: string): IndentNode | undefined => nodes.find((n) => n.key === key);

export type ComposeService = { name: string; context?: string; dependsOn: string[] };

/**
 * The slice of a docker-compose file this needs: each service's name, its local build context (`build: ./x`
 * or `build: { context: ./x }`; an `image:`-only service has none), and what it `depends_on` (a list, or the
 * keys of a map — the map form's per-dependency `condition:` is ignored).
 */
export function parseCompose(text: string): ComposeService[] {
  const services = child(parseIndentedTree(text), "services");
  return (services?.children ?? []).map((svc) => {
    const build = child(svc.children, "build");
    const context = build && (build.value || child(build.children, "context")?.value);
    const dependsOn = child(svc.children, "depends_on");
    const list = dependsOn?.value.startsWith("[")
      ? dependsOn.value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
      : (dependsOn?.children ?? []).map((c) => c.key);
    return { name: svc.key, context: context || undefined, dependsOn: list };
  });
}

/**
 * Links docker-compose files to the services they build and deploy. A compose service resolves to a known
 * code service only when its build context is exactly one of `services`' manifest folders (no fuzzy
 * matching: a wrong link is worse than no link). `depends_on` between two resolved services becomes an edge
 * between one real file from each (its first file in path order, so it is deterministic) — reusing the
 * existing import-graph visualization instead of inventing a new edge kind.
 */
export function linkCompose(
  fs: FileSystemHost,
  root: string,
  composeAbsPaths: readonly string[],
  services: readonly Service[],
  nodesSoFar: readonly CodeGraphNode[],
  serviceOf: (relPath: string) => string,
): ComposeLinkOutput {
  const rel = (abs: string): string => abs.slice(root.length + 1);
  const knownPaths = new Set(services.map((s) => s.path));
  const representative = new Map<string, string>(); // service path -> one of its files (first by path order)
  for (const n of nodesSoFar) if (n.service && !representative.has(n.service)) representative.set(n.service, n.path);

  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  for (const abs of composeAbsPaths) {
    const text = fs.readFile(abs);
    if (text === undefined) continue;
    const composeRel = rel(abs);
    const composeDir = dirname(composeRel);
    const parsed = parseCompose(text);
    const resolvedOf = new Map<string, string>(); // compose service name -> code service path
    for (const svc of parsed) {
      if (!svc.context) continue;
      const path = join(composeDir, svc.context);
      if (knownPaths.has(path)) resolvedOf.set(svc.name, path);
    }
    const added = new Set<string>();
    for (const svc of parsed) {
      const servicePath = resolvedOf.get(svc.name);
      const file = servicePath && representative.get(servicePath);
      if (file && !added.has(file)) {
        edges.push({ source: composeRel, target: file }); // the compose file deploys this service
        added.add(file);
      }
      for (const dep of svc.dependsOn) {
        const depPath = resolvedOf.get(dep);
        const from = servicePath && representative.get(servicePath);
        const to = depPath && representative.get(depPath);
        if (from && to && from !== to) edges.push({ source: from, target: to }); // service depends_on service
      }
    }
    if (added.size) {
      const folder = composeDir || ".";
      const ext = composeRel.slice(composeRel.lastIndexOf(".") + 1);
      nodes.push({ id: composeRel, path: composeRel, folder, ext, loc: countLines(text), inDegree: 0, outDegree: 0, lang: "compose", service: serviceOf(composeRel) });
    }
  }
  return { nodes, edges };
}

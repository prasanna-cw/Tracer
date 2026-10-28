import type { CodeGraphEdge, CodeGraphNode } from "../graph/types";
import type { FactsFile } from "./linkFacts";
import type { FileSystemHost } from "./fileSystem";

export type DocLinkOutput = { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] };

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

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g; // [text](path#anchor)
const CODE_SPAN = /`([A-Za-z_][A-Za-z0-9_]*)`/g; // `identifier`
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i; // a URL scheme (http:, mailto:, …), not a relative path
const ADR_DIR = /(^|\/)adr(\/|$)/i; // docs/adr/0001-....md, or any "adr" folder

/**
 * Links Markdown files to the code they document: a relative link (`[x](./src/a.ts)`) to the file it points
 * to, and a code span (`` `functionName` ``) to the one file declaring that exact name — skipped when more
 * than one file does, since a wrong link is worse than no link (same rule `linkFacts` uses for type names).
 * Names only come from already-indexed tree-sitter facts (non-TypeScript languages); a TypeScript-only repo
 * still gets relative-link resolution, just not code-span matching.
 */
export function linkDocs(
  fs: FileSystemHost,
  root: string,
  docAbsPaths: readonly string[],
  factsFiles: readonly FactsFile[],
  byPath: ReadonlyMap<string, CodeGraphNode>,
  serviceOf: (relPath: string) => string,
): DocLinkOutput {
  const rel = (abs: string): string => abs.slice(root.length + 1);

  const byName = new Map<string, string[]>(); // symbol name -> declaring files (ambiguous names dropped below)
  const add = (name: string, file: string) => {
    const list = byName.get(name);
    if (list) {
      if (!list.includes(file)) list.push(file);
    } else byName.set(name, [file]);
  };
  for (const f of factsFiles) {
    for (const t of f.facts.types) add(t.name, f.rel);
    for (const fn of f.facts.functions) if (!fn.container) add(fn.name, f.rel); // top-level only: a bare method name is too ambiguous
  }

  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  for (const abs of docAbsPaths) {
    const text = fs.readFile(abs);
    if (text === undefined) continue;
    const docRel = rel(abs);
    const docDir = dirname(docRel);
    const added = new Set<string>();
    const link = (target: string) => {
      if (target !== docRel && byPath.has(target) && !added.has(target)) {
        edges.push({ source: docRel, target });
        added.add(target);
      }
    };

    for (const m of text.matchAll(MD_LINK)) {
      const href = (m[1] ?? "").split("#")[0] ?? "";
      if (!href || EXTERNAL.test(href)) continue;
      link(normalize(href.startsWith("/") ? href.slice(1) : join(docDir, href)));
    }
    for (const m of text.matchAll(CODE_SPAN)) {
      const candidates = byName.get(m[1] as string);
      if (candidates?.length === 1) link(candidates[0] as string);
    }

    const ext = docRel.slice(docRel.lastIndexOf(".") + 1);
    const lang = ADR_DIR.test(docDir) ? "adr" : "markdown";
    nodes.push({ id: docRel, path: docRel, folder: docDir || ".", ext, loc: countLines(text), inDegree: 0, outDegree: 0, lang, service: serviceOf(docRel) });
  }
  return { nodes, edges };
}

import type { Node } from "web-tree-sitter";
import type { LangId, LanguageSpec, TypeKind } from "./languages";

/** What one source file declares and uses: everything the workspace graph needs, nothing more. */
export type FileFacts = {
  lang: LangId;
  loc: number;
  /** Declared package / namespace / module path (Java `package`, C# `namespace`, Go `package`, PHP `namespace`). */
  package?: string;
  /** Raw import specifiers, as written (see LanguageSpec.imports for each language's encoding). */
  imports: string[];
  types: { name: string; kind: TypeKind; line: number }[];
  functions: { name: string; container?: string; line: number; endLine: number }[];
  /** Capitalized names the file mentions in type positions (linked by name to the files declaring them). */
  typeRefs: string[];
  syntaxErrors: boolean;
};

const IMPORT_NODES = new Set([
  "import_declaration", "import_header", "import_statement", "import_from_statement", "import_spec",
  "using_directive", "use_declaration", "mod_item", "preproc_include", "namespace_use_clause",
  "require_expression", "require_once_expression", "include_expression", "include_once_expression",
  "call", "uri",
]);
const PACKAGE_NODES = new Set([
  "package_declaration", "package_header", "package_clause",
  "namespace_declaration", "file_scoped_namespace_declaration", "namespace_definition",
]);
const NAME_NODES = new Set(["identifier", "simple_identifier", "type_identifier", "constant", "field_identifier", "property_identifier", "name"]);
const MAX_TYPE_REFS = 400;

/** The declared name of a function/type node, across grammars (name field, C declarators, Kotlin/Swift children, `const f = () => …`). */
export function nameOf(n: Node): string | undefined {
  const named = n.childForFieldName("name");
  if (named) return named.text;
  let d = n.childForFieldName("declarator");
  while (d) {
    if (/identifier$/.test(d.type)) return d.text;
    const inner = d.childForFieldName("declarator");
    if (!inner) return d.descendantsOfType(["identifier", "field_identifier", "qualified_identifier"])[0]?.text;
    d = inner;
  }
  const signature = n.namedChildren.find((c) => c?.type === "function_signature");
  if (signature) return nameOf(signature);
  const first = n.namedChildren.find((c) => !!c && NAME_NODES.has(c.type));
  if (first && n.type !== "arrow_function" && n.type !== "function_expression" && n.type !== "lambda_expression") return first.text;
  const p = n.parent;
  if (p && ["variable_declarator", "pair", "assignment_expression", "public_field_definition", "property_declaration"].includes(p.type)) {
    return (p.childForFieldName("name") ?? p.childForFieldName("key") ?? p.childForFieldName("left"))?.text;
  }
  return undefined;
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** One pass over the tree with a cursor (no recursion, few allocations). */
export function extractFacts(spec: LanguageSpec, root: Node, text: string): FileFacts {
  const facts: FileFacts = { lang: spec.id, loc: countLines(text), imports: [], types: [], functions: [], typeRefs: [], syntaxErrors: root.hasError };
  const functions = new Set(spec.functions);
  const typeRefNodes = new Set(spec.typeRefs);
  const refs = new Set<string>();
  const containers: { depth: number; name: string }[] = [];
  const cursor = root.walk();
  let depth = 0;
  for (;;) {
    if (cursor.nodeIsNamed) {
      const type = cursor.nodeType;
      while (containers.length && (containers.at(-1)?.depth ?? -1) >= depth) containers.pop();
      const kind = spec.types[type];
      if (kind || functions.has(type) || IMPORT_NODES.has(type) || PACKAGE_NODES.has(type)) {
        const node = cursor.currentNode;
        if (kind) {
          const name = nameOf(node);
          if (name) {
            facts.types.push({ name, kind, line: node.startPosition.row + 1 });
            containers.push({ depth, name });
          }
        } else if (functions.has(type)) {
          const name = nameOf(node);
          if (name) {
            facts.functions.push({ name, container: containers.at(-1)?.name, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
          }
        } else if (IMPORT_NODES.has(type) && spec.imports) {
          const found = spec.imports(node);
          if (found) for (const s of found) if (s) facts.imports.push(s);
        } else if (PACKAGE_NODES.has(type) && spec.packageOf && !facts.package) {
          facts.package = spec.packageOf(node) || undefined;
        }
      } else if (typeRefNodes.has(type) && refs.size < MAX_TYPE_REFS) {
        const t = cursor.nodeText;
        if (/^[A-Z]/.test(t) && t.length < 80) refs.add(t);
      }
    }
    if (cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        facts.typeRefs = [...refs];
        return facts;
      }
      depth--;
    }
  }
}

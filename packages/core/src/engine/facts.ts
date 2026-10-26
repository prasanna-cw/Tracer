import type { Node } from "web-tree-sitter";
import { cleanCallee } from "./callee";
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
  /** `calls`: distinct callee names (as written, up to the first parenthesis) in source order, nested functions excluded. */
  functions: { name: string; container?: string; line: number; endLine: number; calls: string[] }[];
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
const MAX_CALLS = 60;


/** The declared name of a function/type node, across grammars (name field, C declarators, Kotlin/Swift children, `const f = () => …`). */
export function nameOf(n: Node): string | undefined {
  const fixed = FIXED_NAMES[n.type];
  if (fixed) return fixed(n) || undefined;
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
  if (first && !ANONYMOUS.has(n.type)) return first.text;
  let p = n.parent;
  while (p && (p.type === "expression_list" || p.type === "parenthesized_expression")) p = p.parent; // Go `var a = func…`, `(x) => …` in parens
  if (p && ASSIGNMENTS.has(p.type)) {
    const target =
      p.childForFieldName("name") ?? p.childForFieldName("key") ?? p.childForFieldName("left") ?? p.childForFieldName("pattern") ??
      p.namedChildren.find((c) => c?.type === "variable_declaration")?.namedChildren.find((c) => !!c && NAME_NODES.has(c.type)) ??
      p.namedChildren.find((c) => c?.type === "variable_list"); // Lua `local f = function() … end`
    return target ? clipName(target.text) : undefined;
  }
  return undefined;
}

const ANONYMOUS = new Set(["arrow_function", "function_expression", "lambda_expression", "lambda", "lambda_literal", "closure_expression", "func_literal", "anonymous_function", "anonymous_function_creation_expression", "function_definition", "do_block", "block"]);
const ASSIGNMENTS = new Set([
  "variable_declarator", "pair", "assignment_expression", "public_field_definition", "property_declaration", "assignment", "var_spec",
  "short_var_declaration", "val_definition", "var_definition", "variable_declaration", "property_signature", "field_definition",
  "local_variable_declaration", "variable_assignment", "assignment_statement",
]);
const clipName = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
};
/** The property a Kotlin getter/setter, C#/Swift accessor belongs to. */
const propertyName = (n: Node): string => {
  let p: Node | null = n.parent;
  while (p && p.type !== "property_declaration") p = p.parent;
  const prop = p ?? n.previousNamedSibling; // Kotlin puts get()/set() next to the property, not inside it
  if (!prop || prop.type !== "property_declaration") return "property";
  const name = prop.childForFieldName("name") ?? prop.namedChildren.find((c) => c?.type === "variable_declaration") ?? null;
  const id = name?.type === "variable_declaration" ? name.namedChildren.find((c) => !!c && NAME_NODES.has(c.type)) : name;
  return clipName(id?.descendantsOfType(["simple_identifier", "identifier"])[0]?.text ?? id?.text ?? "property");
};
// The accessor keyword, not the modifier before it (`private set;`).
const accessorWord = (n: Node): string => (n.children.some((c) => !!c && !c.isNamed && /^(set|init)$/.test(c.type)) || /setter/.test(n.type) ? "set" : "get");
/** An accessor with no body (`{ get; set; }`) is part of an auto-property, not a function. */
const hasBody = (n: Node): boolean => !!n.childForFieldName("body") || n.namedChildren.some((c) => c?.type === "block" || c?.type === "arrow_expression_clause");
// Functions that have no name of their own in the grammar: named after what they are.
const FIXED_NAMES: Record<string, (n: Node) => string> = {
  anonymous_initializer: () => "init",
  static_initializer: () => "static init",
  secondary_constructor: () => "constructor",
  deinit_declaration: () => "deinit",
  destructor_declaration: (n) => `~${n.childForFieldName("name")?.text ?? ""}`,
  operator_declaration: (n) => `operator ${n.children.find((c) => !!c && !c.isNamed && /^[^\w\s(]+$|^(true|false)$/.test(c.type))?.text ?? ""}`.trim(),
  conversion_operator_declaration: (n) => `operator ${n.childForFieldName("type")?.text ?? ""}`.trim(),
  accessor_declaration: (n) => (hasBody(n) ? `${propertyName(n)}.${accessorWord(n)}` : ""),
  getter: (n) => `${propertyName(n)}.get`,
  setter: (n) => `${propertyName(n)}.set`,
  computed_getter: (n) => `${propertyName(n)}.get`,
  computed_setter: (n) => `${propertyName(n)}.set`,
  computed_property: (n) => propertyName(n),
};

/** Iteration callbacks (`items.map(x => …)`, `each do |x|`) behave like loop bodies, not like functions of their own. */
const ITERATION = /(^|\.)(map|forEach|filter|reduce|reduceRight|flatMap|some|every|find|findIndex|findLast|sort|sortBy|each|each_with_index|each_with_object|map!|select|reject|collect|times|upto|downto|each_pair|each_key|each_value|Select|Where|ForEach|let|also|apply|run|with|forEachIndexed|mapNotNull|iter|for_each|into_iter|fold|any|all|count)$/;

/** The call a nameless function is an argument (or the block) of, if any. */
export function callOfCallback(n: Node): Node | undefined {
  let p = n.parent;
  for (let i = 0; p && i < 4; i++, p = p.parent) {
    if (CALL_NODE.test(p.type)) return p;
    if (!/argument|call_suffix|annotated_lambda|parenthesized/.test(p.type)) return undefined;
  }
  return undefined;
}
const CALL_NODE = /^(call|call_expression|invocation_expression|method_invocation|function_call_expression|member_call_expression|scoped_call_expression|function_call)$/;

/** True for a nameless function passed to an iteration method (`map`, `forEach`, `each`, …). */
export function isIterationCallback(n: Node): boolean {
  if (nameOf(n)) return false;
  const call = callOfCallback(n);
  return !!call && ITERATION.test(calleeOf(call));
}

function calleeOf(call: Node): string {
  const f = call.childForFieldName("function") ?? call.childForFieldName("method") ?? call.childForFieldName("target") ?? call.childForFieldName("name");
  const recv = call.childForFieldName("receiver") ?? call.childForFieldName("object") ?? call.childForFieldName("scope");
  const head = f ? (recv && f.startIndex > recv.endIndex ? `${recv.text}.${f.text}` : f.text) : call.text;
  return cleanCallee(head.split("\n")[0] ?? "").replace(/\s.*$/, "");
}

/**
 * A name for any function node: its declared name, else one made from where it sits
 * (`app.get "/orders" callback`, `default export`, `anonymous (line 12)`).
 */
export function functionLabel(n: Node): string {
  const own = nameOf(n);
  if (own) return own;
  const call = callOfCallback(n);
  const callee = call?.childForFieldName("function");
  if (call && !(callee && callee.startIndex <= n.startIndex && n.endIndex <= callee.endIndex)) {
    // `const Button = forwardRef((p, ref) => …)`: the variable names the wrapped function.
    const holder = call.parent && ASSIGNMENTS.has(call.parent.type) ? call.parent : undefined;
    const held = holder && (holder.childForFieldName("name") ?? holder.childForFieldName("left"));
    if (held) return clipName(held.text);
    const str = call.descendantsOfType(["string", "string_literal", "interpreted_string_literal", "string_content"]).find((s) => !!s && s.startIndex < n.startIndex);
    const arg = str ? ` ${clipName(str.text.startsWith("\"") || str.text.startsWith("'") || str.text.startsWith("`") ? str.text : `"${str.text}"`)}` : "";
    return `${calleeOf(call)}${arg} callback`;
  }
  if (n.parent?.type === "export_statement" || n.parent?.type === "export_default_declaration") return "default export";
  return `anonymous (line ${n.startPosition.row + 1})`;
}

/** Last row of a function including its body; Dart keeps the body next to the signature, not inside it. */
export function bodyEndRow(n: Node): number {
  const body = dartBody(n);
  return (body ?? n).endPosition.row;
}

/** Dart: `method_signature { function_signature } function_body` – the body is the signature's next sibling. */
export function dartBody(n: Node): Node | undefined {
  let sig: Node = n;
  while (sig.parent && /signature|^declaration$/.test(sig.parent.type)) sig = sig.parent;
  return sig.nextNamedSibling?.type === "function_body" ? sig.nextNamedSibling : undefined;
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
  const calls = new Set(spec.calls);
  const fnStack: { depth: number; index: number }[] = []; // innermost function last
  const cursor = root.walk();
  let depth = 0;
  for (;;) {
    if (cursor.nodeIsNamed) {
      const type = cursor.nodeType;
      while (containers.length && (containers.at(-1)?.depth ?? -1) >= depth) containers.pop();
      while (fnStack.length && (fnStack.at(-1)?.depth ?? -1) >= depth) fnStack.pop();
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
          // Named functions always; a nameless one (route handler, test body, IIFE) only at the top level, where
          // nothing else would hold its calls. Nested callbacks stay part of their enclosing function.
          const name = nameOf(node) ?? (fnStack.length || FIXED_NAMES[type] || isIterationCallback(node) ? undefined : functionLabel(node));
          if (name) {
            facts.functions.push({ name, container: containers.at(-1)?.name, line: node.startPosition.row + 1, endLine: bodyEndRow(node) + 1, calls: [] });
            fnStack.push({ depth, index: facts.functions.length - 1 });
          }
        } else if (IMPORT_NODES.has(type) && spec.imports) {
          const found = spec.imports(node);
          if (found) for (const s of found) if (s) facts.imports.push(s);
        } else if (PACKAGE_NODES.has(type) && spec.packageOf && !facts.package) {
          facts.package = spec.packageOf(node) || undefined;
        }
      }
      // Not `else`: in Python, Ruby and Elixir a call node is also where imports live (`require`, `import`).
      if (calls.has(type) && fnStack.length) {
        const fn = facts.functions[fnStack.at(-1)?.index ?? -1];
        // `call` is also where Ruby/Python imports live and where calls have no parentheses: read the callee from its fields.
        const name = type === "call" ? calleeOf(cursor.currentNode) : cleanCallee(cursor.nodeText);
        if (fn && name && !/^(require|require_relative|load)$/.test(name) && fn.calls.length < MAX_CALLS && !fn.calls.includes(name)) fn.calls.push(name);
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

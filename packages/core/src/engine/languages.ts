import type { Node } from "web-tree-sitter";

/**
 * What Tracer knows about each language's syntax tree (tree-sitter grammars from `tree-sitter-wasms`).
 * One generic walker reads every language through these specs; node names were taken from real parse
 * trees (see test/engine.test.ts, which pins them per language).
 *
 * Tiers:
 * - deep: functions, calls, control flow, and imports linked across files.
 * - standard: functions, calls and imports; control flow where the grammar exposes it.
 */

export type LangId =
  | "typescript" | "tsx" | "javascript"
  | "java" | "kotlin" | "python" | "go" | "csharp"
  | "rust" | "c" | "cpp" | "php" | "ruby" | "swift" | "scala" | "dart" | "lua" | "elixir" | "zig";

export type TypeKind = "class" | "interface" | "struct" | "enum" | "trait" | "object" | "module" | "type";

/** How a language's imports are linked to files. */
export type Resolution = "typescript" | "name" | "python" | "go" | "rust" | "include" | "php" | "ruby" | "dart" | "none";

export type ControlSpec = {
  if: string[];
  loop: string[];
  switch: string[];
  try: string[];
  return: string[];
  throw: string[];
};

export type LanguageSpec = {
  id: LangId;
  name: string;
  grammar: string; // tree-sitter-<grammar>.wasm
  extensions: string[];
  tier: "deep" | "standard";
  resolution: Resolution;
  functions: string[];
  types: Record<string, TypeKind>;
  calls: string[];
  control: ControlSpec;
  /** Identifier node types that can name a type (for name-based linking). */
  typeRefs: string[];
  /** Raw import specifiers declared by this node, if it is an import. */
  imports?: (n: Node) => string[] | undefined;
  /** Package / namespace / module path the file declares. */
  packageOf?: (n: Node) => string | undefined;
};

const text = (n: Node | null | undefined): string => n?.text ?? "";
const unquote = (s: string): string => s.replace(/^["'`]|["'`]$/g, "");
const child = (n: Node, ...types: string[]): Node | undefined =>
  n.namedChildren.find((c): c is Node => !!c && types.includes(c.type));

const NO_CONTROL: ControlSpec = { if: [], loop: [], switch: [], try: [], return: [], throw: [] };

const TS_LIKE: Omit<LanguageSpec, "id" | "name" | "grammar" | "extensions"> = {
  tier: "deep",
  resolution: "typescript",
  functions: ["function_declaration", "generator_function_declaration", "method_definition", "arrow_function", "function_expression", "function"],
  types: { class_declaration: "class", abstract_class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", type_alias_declaration: "type" },
  calls: ["call_expression", "new_expression"],
  control: {
    if: ["if_statement"],
    loop: ["for_statement", "for_in_statement", "while_statement", "do_statement"],
    switch: ["switch_statement"],
    try: ["try_statement"],
    return: ["return_statement"],
    throw: ["throw_statement"],
  },
  typeRefs: ["type_identifier"],
};

export const LANGUAGES: LanguageSpec[] = [
  { ...TS_LIKE, id: "typescript", name: "TypeScript", grammar: "typescript", extensions: [".ts", ".mts", ".cts"] },
  { ...TS_LIKE, id: "tsx", name: "TypeScript (TSX)", grammar: "tsx", extensions: [".tsx"] },
  { ...TS_LIKE, id: "javascript", name: "JavaScript", grammar: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"], typeRefs: [] },
  {
    id: "java",
    name: "Java",
    grammar: "java",
    extensions: [".java"],
    tier: "deep",
    resolution: "name",
    functions: ["method_declaration", "constructor_declaration", "lambda_expression"],
    types: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "class", annotation_type_declaration: "interface" },
    calls: ["method_invocation", "object_creation_expression"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement", "enhanced_for_statement", "while_statement", "do_statement"],
      switch: ["switch_expression", "switch_statement"],
      try: ["try_statement", "try_with_resources_statement"],
      return: ["return_statement"],
      throw: ["throw_statement"],
    },
    typeRefs: ["type_identifier"],
    imports: (n) => {
      if (n.type !== "import_declaration") return undefined;
      const path = child(n, "scoped_identifier", "identifier");
      return path ? [n.text.includes("*") ? `${path.text}.*` : path.text] : [];
    },
    packageOf: (n) => (n.type === "package_declaration" ? text(child(n, "scoped_identifier", "identifier")) : undefined),
  },
  {
    id: "kotlin",
    name: "Kotlin",
    grammar: "kotlin",
    extensions: [".kt", ".kts"],
    tier: "deep",
    resolution: "name",
    functions: ["function_declaration", "anonymous_function", "lambda_literal", "secondary_constructor"],
    types: { class_declaration: "class", object_declaration: "object", interface_declaration: "interface" },
    calls: ["call_expression"],
    control: {
      if: ["if_expression"],
      loop: ["for_statement", "while_statement", "do_while_statement"],
      switch: ["when_expression"],
      try: ["try_expression"],
      return: ["jump_expression"], // `return`/`throw`/`break` share a node; the walker reads the keyword
      throw: [],
    },
    typeRefs: ["type_identifier"],
    imports: (n) => (n.type === "import_header" ? [text(child(n, "identifier")) + (n.text.includes(".*") ? ".*" : "")] : undefined),
    packageOf: (n) => (n.type === "package_header" ? text(child(n, "identifier")) : undefined),
  },
  {
    id: "python",
    name: "Python",
    grammar: "python",
    extensions: [".py", ".pyi"],
    tier: "deep",
    resolution: "python",
    functions: ["function_definition", "lambda"],
    types: { class_definition: "class" },
    calls: ["call"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement", "while_statement"],
      switch: ["match_statement"],
      try: ["try_statement", "with_statement"],
      return: ["return_statement"],
      throw: ["raise_statement"],
    },
    typeRefs: [],
    imports: (n) => {
      if (n.type === "import_statement") {
        return n.namedChildren.flatMap((c) => (c?.type === "dotted_name" ? [c.text] : c?.type === "aliased_import" ? [text(c.childForFieldName("name"))] : []));
      }
      if (n.type === "import_from_statement") {
        // "from a.b import c, d" -> "a.b:c", "a.b:d" (c may be a submodule or a name inside a.b)
        const mod = text(n.childForFieldName("module_name"));
        const names = n.childrenForFieldName("name").map((c) => (c?.type === "aliased_import" ? text(c.childForFieldName("name")) : text(c)));
        return names.length ? names.map((name) => `${mod}:${name}`) : [`${mod}:*`];
      }
      return undefined;
    },
  },
  {
    id: "go",
    name: "Go",
    grammar: "go",
    extensions: [".go"],
    tier: "deep",
    resolution: "go",
    functions: ["function_declaration", "method_declaration", "func_literal"],
    types: { type_spec: "type" },
    calls: ["call_expression"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement"],
      switch: ["expression_switch_statement", "type_switch_statement", "select_statement"],
      try: [],
      return: ["return_statement"],
      throw: [],
    },
    typeRefs: [],
    imports: (n) => (n.type === "import_spec" ? [unquote(text(n.childForFieldName("path")))] : undefined),
    packageOf: (n) => (n.type === "package_clause" ? text(child(n, "package_identifier")) : undefined),
  },
  {
    id: "csharp",
    name: "C#",
    grammar: "c_sharp",
    extensions: [".cs"],
    tier: "deep",
    resolution: "name",
    functions: ["method_declaration", "constructor_declaration", "local_function_statement", "lambda_expression"],
    types: { class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", record_declaration: "class", enum_declaration: "enum" },
    calls: ["invocation_expression", "object_creation_expression"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement", "for_each_statement", "while_statement", "do_statement"],
      switch: ["switch_statement", "switch_expression"],
      try: ["try_statement", "using_statement"],
      return: ["return_statement"],
      throw: ["throw_statement", "throw_expression"],
    },
    typeRefs: ["identifier"], // C# types are plain identifiers; only names in the type index count
    imports: (n) => (n.type === "using_directive" ? [text(child(n, "qualified_name", "identifier"))] : undefined),
    packageOf: (n) =>
      n.type === "namespace_declaration" || n.type === "file_scoped_namespace_declaration" ? text(n.childForFieldName("name")) : undefined,
  },
  {
    id: "rust",
    name: "Rust",
    grammar: "rust",
    extensions: [".rs"],
    tier: "standard",
    resolution: "rust",
    functions: ["function_item", "closure_expression"],
    types: { struct_item: "struct", enum_item: "enum", trait_item: "trait", union_item: "struct" },
    calls: ["call_expression", "macro_invocation"],
    control: {
      if: ["if_expression"],
      loop: ["for_expression", "while_expression", "loop_expression"],
      switch: ["match_expression"],
      try: [],
      return: ["return_expression"],
      throw: [],
    },
    typeRefs: ["type_identifier"],
    imports: (n) => {
      if (n.type === "use_declaration") return [text(n.childForFieldName("argument"))];
      // `mod util;` (no body) pulls in util.rs / util/mod.rs
      if (n.type === "mod_item" && !n.childForFieldName("body")) return [`mod:${text(n.childForFieldName("name"))}`];
      return undefined;
    },
  },
  {
    id: "c",
    name: "C",
    grammar: "c",
    extensions: [".c", ".h"],
    tier: "standard",
    resolution: "include",
    functions: ["function_definition"],
    types: { struct_specifier: "struct", enum_specifier: "enum", union_specifier: "struct" },
    calls: ["call_expression"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement", "while_statement", "do_statement"],
      switch: ["switch_statement"],
      try: [],
      return: ["return_statement"],
      throw: [],
    },
    typeRefs: ["type_identifier"],
    imports: (n) => (n.type === "preproc_include" ? includePath(n) : undefined),
  },
  {
    id: "cpp",
    name: "C++",
    grammar: "cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    tier: "standard",
    resolution: "include",
    functions: ["function_definition", "lambda_expression"],
    types: { class_specifier: "class", struct_specifier: "struct", enum_specifier: "enum" },
    calls: ["call_expression", "new_expression"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement", "for_range_loop", "while_statement", "do_statement"],
      switch: ["switch_statement"],
      try: ["try_statement"],
      return: ["return_statement"],
      throw: ["throw_statement"],
    },
    typeRefs: ["type_identifier"],
    imports: (n) => (n.type === "preproc_include" ? includePath(n) : undefined),
  },
  {
    id: "php",
    name: "PHP",
    grammar: "php",
    extensions: [".php"],
    tier: "standard",
    resolution: "php",
    functions: ["function_definition", "method_declaration", "anonymous_function", "arrow_function"],
    types: { class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait", enum_declaration: "enum" },
    calls: ["function_call_expression", "member_call_expression", "scoped_call_expression", "object_creation_expression"],
    control: {
      if: ["if_statement"],
      loop: ["for_statement", "foreach_statement", "while_statement", "do_statement"],
      switch: ["switch_statement", "match_expression"],
      try: ["try_statement"],
      return: ["return_statement"],
      throw: ["throw_expression"],
    },
    typeRefs: ["name"],
    imports: (n) => {
      if (n.type === "namespace_use_clause") return [n.text.replace(/\s+as\s+\w+$/i, "")];
      if (/^(require|include)(_once)?_expression$/.test(n.type)) {
        const s = n.descendantsOfType("string_content")[0] ?? n.descendantsOfType("string_value")[0];
        return s ? [`path:${s.text}`] : [];
      }
      return undefined;
    },
    packageOf: (n) => (n.type === "namespace_definition" ? text(n.childForFieldName("name")) : undefined),
  },
  {
    id: "ruby",
    name: "Ruby",
    grammar: "ruby",
    extensions: [".rb"],
    tier: "standard",
    resolution: "ruby",
    functions: ["method", "singleton_method", "lambda"],
    types: { class: "class", module: "module" },
    calls: ["call"],
    control: {
      if: ["if", "unless", "if_modifier", "unless_modifier"],
      loop: ["while", "until", "for", "while_modifier", "until_modifier"],
      switch: ["case"],
      try: ["begin"],
      return: ["return"],
      throw: [],
    },
    typeRefs: ["constant"],
    imports: (n) => {
      if (n.type !== "call") return undefined;
      const method = text(n.childForFieldName("method"));
      if (method !== "require" && method !== "require_relative" && method !== "load") return undefined;
      const s = n.childForFieldName("arguments")?.descendantsOfType("string_content")[0];
      return s ? [`${method === "require_relative" ? "rel" : "lib"}:${s.text}`] : [];
    },
  },
  {
    id: "swift",
    name: "Swift",
    grammar: "swift",
    extensions: [".swift"],
    tier: "standard",
    resolution: "name",
    functions: ["function_declaration", "init_declaration", "lambda_literal"],
    types: { class_declaration: "class", protocol_declaration: "interface" },
    calls: ["call_expression"],
    control: {
      if: ["if_statement", "guard_statement"],
      loop: ["for_statement", "while_statement", "repeat_while_statement"],
      switch: ["switch_statement"],
      try: ["do_statement"],
      return: ["control_transfer_statement"],
      throw: [],
    },
    typeRefs: ["type_identifier"],
    imports: (n) => (n.type === "import_declaration" ? [text(child(n, "identifier"))] : undefined),
  },
  {
    id: "scala",
    name: "Scala",
    grammar: "scala",
    extensions: [".scala", ".sc"],
    tier: "standard",
    resolution: "name",
    functions: ["function_definition", "lambda_expression"],
    types: { class_definition: "class", object_definition: "object", trait_definition: "trait", enum_definition: "enum" },
    calls: ["call_expression"],
    control: { ...NO_CONTROL, if: ["if_expression"], switch: ["match_expression"], try: ["try_expression"] },
    typeRefs: ["type_identifier"],
    imports: (n) => (n.type === "import_declaration" ? [text(n.childForFieldName("path"))] : undefined),
    packageOf: (n) => (n.type === "package_clause" ? text(n.childForFieldName("name")) : undefined),
  },
  {
    id: "dart",
    name: "Dart",
    grammar: "dart",
    extensions: [".dart"],
    tier: "standard",
    resolution: "dart",
    functions: ["function_signature", "function_expression"], // a method_signature wraps a function_signature
    types: { class_definition: "class", mixin_declaration: "class", enum_declaration: "enum", extension_declaration: "class" },
    calls: [],
    control: { ...NO_CONTROL, if: ["if_statement"], loop: ["for_statement", "while_statement", "do_statement"], switch: ["switch_statement"], try: ["try_statement"], return: ["return_statement"], throw: ["throw_expression"] },
    typeRefs: ["type_identifier"],
    imports: (n) => (n.type === "uri" ? [unquote(n.text)] : undefined),
  },
  {
    id: "lua",
    name: "Lua",
    grammar: "lua",
    extensions: [".lua"],
    tier: "standard",
    resolution: "none",
    functions: ["function_declaration", "function_definition"],
    types: {},
    calls: ["function_call"],
    control: { ...NO_CONTROL, if: ["if_statement"], loop: ["for_statement", "while_statement", "repeat_statement"], return: ["return_statement"] },
    typeRefs: [],
  },
  {
    id: "elixir",
    name: "Elixir",
    grammar: "elixir",
    extensions: [".ex", ".exs"],
    tier: "standard",
    resolution: "none",
    functions: [],
    types: {},
    calls: ["call"],
    control: NO_CONTROL,
    typeRefs: ["alias"],
  },
  {
    id: "zig",
    name: "Zig",
    grammar: "zig",
    extensions: [".zig"],
    tier: "standard",
    resolution: "none",
    functions: ["FnProto"],
    types: {},
    calls: [],
    control: NO_CONTROL,
    typeRefs: [],
  },
];

function includePath(n: Node): string[] {
  const path = n.childForFieldName("path");
  if (!path || path.type === "system_lib_string") return []; // <vector>: system header, never ours
  return [unquote(path.text)];
}

const BY_EXTENSION = new Map(LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l] as const)));
export const languageForPath = (path: string): LanguageSpec | undefined => {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : BY_EXTENSION.get(path.slice(dot).toLowerCase());
};
export const languageById = (id: string): LanguageSpec | undefined => LANGUAGES.find((l) => l.id === id);

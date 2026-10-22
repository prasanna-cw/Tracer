import ts from "typescript";
import { cycleEdgeKeys, findCycles } from "../graph/algorithms";
import type { CodeGraph, CodeGraphEdge, CodeGraphNode } from "../graph/types";
import { joinPath, type FileSystemHost } from "./fileSystem";
import { parseGitignore, type IgnoreMatcher } from "./gitignore";

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;
const ALWAYS_IGNORED = new Set(["node_modules", "dist", "build", ".git", "coverage"]);
const MAX_UNRESOLVED_LISTED = 200;

// Code-point order, not localeCompare: output must be byte-identical on every machine and locale.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type AnalyzeResult = { graph: CodeGraph; cycleEdges: number };

/**
 * Builds the import graph of the repo at `root` (absolute, forward slashes). Never throws on bad input
 * files: syntax errors and an unreadable tsconfig become warnings in the summary.
 */
export function analyzeRepo(fs: FileSystemHost, root: string): AnalyzeResult {
  root = root.replace(/\/+$/, "");
  const warnings: string[] = [];
  const rel = (abs: string): string => abs.slice(root.length + 1);

  const options = compilerOptions(fs, root, warnings);
  const ignore = gitignore(fs, root, warnings);
  const files = walk(fs, root, ignore);

  // Pass 1: parse one file at a time and keep only its specifiers; the AST is dropped right away.
  const parsed = new Map<string, { specifiers: string[]; loc: number }>();
  for (const abs of files) {
    const text = fs.readFile(abs);
    if (text === undefined) {
      warnings.push(`${rel(abs)}: could not be read; skipped`);
      continue;
    }
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, false, scriptKind(abs));
    const syntaxError = parseDiagnostics(sf)[0];
    if (syntaxError) {
      const { line } = ts.getLineAndCharacterOfPosition(sf, syntaxError.start ?? 0);
      const message = ts.flattenDiagnosticMessageText(syntaxError.messageText, " ");
      warnings.push(`${rel(abs)}:${line + 1}: syntax error (${message}); skipped`);
      continue;
    }
    parsed.set(abs, { specifiers: collectSpecifiers(sf), loc: countLines(text) });
  }

  // Pass 2: resolve with TypeScript's own module resolution (paths, baseUrl, index files, .js -> .ts).
  const host: ts.ModuleResolutionHost = {
    fileExists: (p) => fs.fileExists(p),
    readFile: (p) => fs.readFile(p),
    directoryExists: (p) => fs.directoryExists(p),
    realpath: fs.realpath?.bind(fs),
    getCurrentDirectory: () => root,
    getDirectories: (p) => fs.readDirectory(p).flatMap((e) => (e.isDirectory ? [e.name] : [])),
  };
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  const aliasMatchers = Object.keys(options.paths ?? {}).map(aliasMatcher);
  const edges = new Map<string, CodeGraphEdge>();
  const unresolved: { from: string; specifier: string }[] = [];
  let unresolvedCount = 0;
  let externalCount = 0;

  for (const [abs, { specifiers }] of parsed) {
    for (const spec of specifiers) {
      const resolved = ts.resolveModuleName(spec, abs, options, host, cache).resolvedModule;
      const target = resolved && !resolved.isExternalLibraryImport ? resolved.resolvedFileName : undefined;
      if (target && parsed.has(target)) {
        if (target !== abs) {
          const e = { source: rel(abs), target: rel(target) };
          edges.set(`${e.source}\u0000${e.target}`, e);
        }
      } else if (spec.startsWith(".") || spec.startsWith("/") || aliasMatchers.some((m) => m(spec))) {
        unresolvedCount++;
        if (unresolved.length < MAX_UNRESOLVED_LISTED) unresolved.push({ from: rel(abs), specifier: spec });
      } else {
        externalCount++;
      }
    }
  }

  const edgeList = [...edges.values()].sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target));
  const nodes: CodeGraphNode[] = [...parsed]
    .map(([abs, { loc }]) => {
      const path = rel(abs);
      const slash = path.lastIndexOf("/");
      const dot = path.lastIndexOf(".");
      return { id: path, path, folder: slash < 0 ? "." : path.slice(0, slash), ext: path.slice(dot + 1), loc, inDegree: 0, outDegree: 0 };
    })
    .sort((a, b) => cmp(a.path, b.path));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edgeList) {
    const [s, t] = [byId.get(e.source), byId.get(e.target)];
    if (s) s.outDegree++;
    if (t) t.inDegree++;
  }
  const cycles = findCycles(
    nodes.map((n) => n.id),
    edgeList,
  );

  return {
    graph: {
      version: 1,
      root: root.slice(root.lastIndexOf("/") + 1),
      nodes,
      edges: edgeList,
      summary: {
        fileCount: nodes.length,
        skippedCount: files.length - nodes.length,
        edgeCount: edgeList.length,
        unresolvedCount,
        externalCount,
        cycleCount: cycles.length,
        unresolved,
        warnings,
      },
    },
    cycleEdges: cycleEdgeKeys(cycles, edgeList).size,
  };
}

function walk(fs: FileSystemHost, root: string, ignore: IgnoreMatcher): string[] {
  const out: string[] = [];
  const visit = (dir: string, relDir: string) => {
    const entries = fs.readDirectory(dir).sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!ALWAYS_IGNORED.has(e.name) && !ignore(relPath, true)) visit(joinPath(dir, e.name), relPath);
      } else if (SOURCE_FILE.test(e.name) && !DECLARATION_FILE.test(e.name) && !ignore(relPath, false)) {
        out.push(joinPath(dir, e.name));
      }
    }
  };
  visit(root, "");
  return out;
}

function gitignore(fs: FileSystemHost, root: string, warnings: string[]): IgnoreMatcher {
  const text = fs.readFile(joinPath(root, ".gitignore"));
  if (text === undefined) return () => false;
  const { matches, unsupported } = parseGitignore(text);
  if (unsupported.length) warnings.push(`.gitignore: negation patterns are not supported and were ignored: ${unsupported.join(", ")}`);
  return matches;
}

/** tsconfig.json at the root if present (paths aliases, baseUrl, extends); JS is always included. */
function compilerOptions(fs: FileSystemHost, root: string, warnings: string[]): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
  const configPath = joinPath(root, "tsconfig.json");
  if (!fs.fileExists(configPath)) return defaults;

  const read = ts.readConfigFile(configPath, (p) => fs.readFile(p));
  if (read.error) {
    warnings.push(`tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}; using defaults`);
    return defaults;
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [], // we walk the tree ourselves (with our ignore rules), not tsconfig's include
      fileExists: (p) => fs.fileExists(p),
      readFile: (p) => fs.readFile(p),
    },
    root,
  );
  const NO_INPUTS = 18003; // expected: readDirectory above returns nothing
  for (const e of parsed.errors.filter((d) => d.code !== NO_INPUTS)) {
    warnings.push(`tsconfig.json: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`);
  }
  const options = { ...parsed.options, allowJs: true };
  if (options.moduleResolution === undefined) {
    options.moduleResolution = defaults.moduleResolution;
    options.module ??= defaults.module;
  }
  return options;
}

/** Every static string a file imports from: import/export-from, import x = require(), require(), import(). */
function collectSpecifiers(sf: ts.SourceFile): string[] {
  const specs: string[] = [];
  const literal = (n: ts.Node | undefined): void => {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))) specs.push(n.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

// ponytail: `parseDiagnostics` is internal to TypeScript but stable for a decade; the public alternative
// (a Program per file, or transpileModule) parses everything twice. Missing property = no syntax errors seen.
const parseDiagnostics = (sf: ts.SourceFile): readonly ts.DiagnosticWithLocation[] =>
  (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];

function scriptKind(path: string): ts.ScriptKind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsx") return ts.ScriptKind.TSX;
  if (ext === "jsx") return ts.ScriptKind.JSX;
  if (ext === "js" || ext === "mjs" || ext === "cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** tsconfig `paths` key ("@core/*", "@ui") -> does this specifier look like it should be an alias? */
function aliasMatcher(key: string): (spec: string) => boolean {
  const star = key.indexOf("*");
  if (star < 0) return (spec) => spec === key;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return (spec) => spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length;
}

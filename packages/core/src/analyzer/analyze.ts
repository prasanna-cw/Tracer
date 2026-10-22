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

  const ignore = gitignore(fs, root, warnings);
  const { files, packages } = walk(fs, root, ignore);

  // Each file resolves against its nearest tsconfig.json (per-package `paths`/`extends` in a monorepo),
  // falling back to defaults when there is none up to the root. Lookups and parsed configs are cached.
  type Config = { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache; aliases: ((spec: string) => boolean)[] };
  const configs = new Map<string, Config>(); // by tsconfig path; "" = none found
  const nearest = new Map<string, string>(); // directory -> tsconfig path or ""
  const configPathFor = (dir: string): string => {
    const known = nearest.get(dir);
    if (known !== undefined) return known;
    const candidate = joinPath(dir, "tsconfig.json");
    const found = fs.fileExists(candidate) ? candidate : dir.length > root.length ? configPathFor(dirname(dir)) : "";
    nearest.set(dir, found);
    return found;
  };
  const configFor = (file: string): Config => {
    const path = configPathFor(dirname(file));
    let config = configs.get(path);
    if (!config) {
      const options = compilerOptions(fs, path, path ? rel(path) : "", warnings);
      config = {
        options,
        cache: ts.createModuleResolutionCache(path ? dirname(path) : root, (f) => f, options),
        aliases: Object.keys(options.paths ?? {}).map(aliasMatcher),
      };
      configs.set(path, config);
    }
    return config;
  };

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
  const edges = new Map<string, CodeGraphEdge>();
  const unresolved: { from: string; specifier: string }[] = [];
  let unresolvedCount = 0;
  let externalCount = 0;
  let assetCount = 0;

  for (const [abs, { specifiers }] of parsed) {
    const { options, cache, aliases } = configFor(abs);
    for (const spec of specifiers) {
      const resolved = ts.resolveModuleName(spec, abs, options, host, cache).resolvedModule;
      // Ours if it lands on a file we parsed, whatever the route: a workspace package resolves through a
      // node_modules symlink and TypeScript flags it as an external library, but its real path is in this repo.
      const target = resolved && parsed.has(resolved.resolvedFileName) ? resolved.resolvedFileName : undefined;
      const isPath = spec.startsWith(".") || spec.startsWith("/");
      const onDisk = resolved?.resolvedFileName ?? (isPath ? resolvePath(abs, spec) : undefined);
      if (target) {
        if (target !== abs) {
          const e = { source: rel(abs), target: rel(target) };
          edges.set(`${e.source}\u0000${e.target}`, e);
        }
      } else if (onDisk && !SOURCE_FILE.test(onDisk) && fs.fileExists(onDisk)) {
        assetCount++; // ./app.css, ./data.json, ./logo.svg: exists, just not code
      } else if (isPath || aliases.some((m) => m(spec))) {
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
      packages,
      nodes,
      edges: edgeList,
      summary: {
        fileCount: nodes.length,
        skippedCount: files.length - nodes.length,
        edgeCount: edgeList.length,
        unresolvedCount,
        externalCount,
        assetCount,
        cycleCount: cycles.length,
        unresolved,
        warnings,
      },
    },
    cycleEdges: cycleEdgeKeys(cycles, edgeList).size,
  };
}

/** `spec` relative to the file importing it, with `.` and `..` folded (absolute `/x` is taken as-is). */
function resolvePath(fromFile: string, spec: string): string {
  const base = spec.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") base.pop();
    else if (part && part !== ".") base.push(part);
  }
  return (spec.startsWith("/") ? "/" : "") + base.join("/");
}

const dirname = (p: string): string => p.slice(0, p.lastIndexOf("/"));

/** Source files to analyze, and the folders below the root that hold a package.json (monorepo packages). */
function walk(fs: FileSystemHost, root: string, ignore: IgnoreMatcher): { files: string[]; packages: string[] } {
  const out: string[] = [];
  const packages: string[] = [];
  const visit = (dir: string, relDir: string) => {
    const entries = fs.readDirectory(dir).sort((a, b) => cmp(a.name, b.name));
    if (relDir && entries.some((e) => !e.isDirectory && e.name === "package.json")) packages.push(relDir);
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
  return { files: out, packages };
}

function gitignore(fs: FileSystemHost, root: string, warnings: string[]): IgnoreMatcher {
  const text = fs.readFile(joinPath(root, ".gitignore"));
  if (text === undefined) return () => false;
  const { matches, unsupported } = parseGitignore(text);
  if (unsupported.length) warnings.push(`.gitignore: negation patterns are not supported and were ignored: ${unsupported.join(", ")}`);
  return matches;
}

/** Options from one tsconfig.json (paths aliases, baseUrl, extends), or defaults when `configPath` is "". JS is always included. */
function compilerOptions(fs: FileSystemHost, configPath: string, label: string, warnings: string[]): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
  if (!configPath) return defaults;

  const read = ts.readConfigFile(configPath, (p) => fs.readFile(p));
  if (read.error) {
    warnings.push(`${label}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}; using defaults`);
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
    dirname(configPath),
  );
  const NO_INPUTS = 18003; // expected: readDirectory above returns nothing
  for (const e of parsed.errors.filter((d) => d.code !== NO_INPUTS)) {
    warnings.push(`${label}: ${ts.flattenDiagnosticMessageText(e.messageText, " ")}`);
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

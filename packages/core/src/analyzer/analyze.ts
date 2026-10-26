import ts from "typescript";
import { cycleEdgeKeys, findCycles } from "../graph/algorithms";
import type { CodeGraph, CodeGraphEdge, CodeGraphNode } from "../graph/types";
import type { FileFacts } from "../engine/facts";
import { languageForPath } from "../engine/languages";
import { joinPath, type FileSystemHost } from "./fileSystem";
import { parseGitignore, type IgnoreMatcher } from "./gitignore";
import { linkFacts, type FactsFile, type Service } from "./linkFacts";

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;
// Dependencies, caches and build output: never the user's code, often thousands of files.
const ALWAYS_IGNORED = new Set([
  "node_modules", "dist", "build", ".git", "coverage",
  ".venv", "venv", "site-packages", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".next", ".nuxt", ".gradle", ".idea", ".vs",
]);
const MAX_UNRESOLVED_LISTED = 200;

// Code-point order, not localeCompare: output must be byte-identical on every machine and locale.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type AnalyzeResult = { graph: CodeGraph; cycleEdges: number };

export type AnalyzeOptions = {
  /**
   * tree-sitter facts for non-TypeScript files, by absolute path (see @tracer/core/engine). The host computes
   * them (possibly on several threads) and passes them in; files of other languages without facts are left out.
   */
  facts?: ReadonlyMap<string, FileFacts>;
};

// Build manifests: a folder holding one is a project / service.
const MANIFESTS: Record<string, string> = {
  "package.json": "npm", "pom.xml": "maven", "build.gradle": "gradle", "build.gradle.kts": "gradle", "settings.gradle": "gradle",
  "go.mod": "go", "Cargo.toml": "cargo", "pyproject.toml": "python", "setup.py": "python", "requirements.txt": "python", "Pipfile": "python",
  "composer.json": "composer", "Gemfile": "ruby", "Package.swift": "swift", "pubspec.yaml": "dart", "build.sbt": "sbt", "CMakeLists.txt": "cmake",
};
const manifestKind = (name: string): string | undefined => MANIFESTS[name] ?? (/\.(csproj|fsproj|vbproj)$/i.test(name) ? "dotnet" : undefined);
const tsLang = (path: string): string => (/\.(m|c)?tsx?$/i.test(path) ? "typescript" : "javascript");

/**
 * Builds the import graph of the repo at `root` (absolute, forward slashes). Never throws on bad input
 * files: syntax errors and an unreadable tsconfig become warnings in the summary.
 */
export function analyzeRepo(fs: FileSystemHost, root: string, opts: AnalyzeOptions = {}): AnalyzeResult {
  root = root.replace(/\/+$/, "");
  const warnings: string[] = [];
  const rel = (abs: string): string => abs.slice(root.length + 1);

  const ignore = gitignore(fs, root, warnings);
  const { files, others, services } = walk(fs, root, ignore);
  const packages = services.filter((s) => s.path).map((s) => s.path);
  const serviceOf = (relPath: string): string =>
    services.reduce((best, s) => (s.path.length > best.length && (relPath === s.path || relPath.startsWith(`${s.path}/`)) ? s.path : best), "");

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

  // Other languages: tree-sitter facts, linked by name and by path.
  const factsFiles: FactsFile[] = others.flatMap((abs) => {
    const facts = opts.facts?.get(abs);
    return facts ? [{ abs, rel: rel(abs), facts, service: serviceOf(rel(abs)) }] : [];
  });
  linkFacts(fs, root, factsFiles, services, {
    edge: (from, toRel) => {
      if (toRel !== from.rel) edges.set(`${from.rel}\u0000${toRel}`, { source: from.rel, target: toRel });
    },
    unresolved: (from, specifier) => {
      unresolvedCount++;
      if (unresolved.length < MAX_UNRESOLVED_LISTED) unresolved.push({ from: from.rel, specifier });
    },
    external: () => void externalCount++,
  });

  const edgeList = [...edges.values()].sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target));
  const node = (path: string, loc: number, lang: string): CodeGraphNode => {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    return { id: path, path, folder: slash < 0 ? "." : path.slice(0, slash), ext: path.slice(dot + 1), loc, inDegree: 0, outDegree: 0, lang, service: serviceOf(path) };
  };
  const nodes: CodeGraphNode[] = [
    ...[...parsed].map(([abs, { loc }]) => node(rel(abs), loc, tsLang(abs))),
    ...factsFiles.map((f) => node(f.rel, f.facts.loc, f.facts.lang)),
  ].sort((a, b) => cmp(a.path, b.path));
  const languages: Record<string, number> = {};
  for (const n of nodes) if (n.lang) languages[n.lang] = (languages[n.lang] ?? 0) + 1;
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
      services: services.map((s) => ({ path: s.path, kind: s.kind })),
      nodes,
      edges: edgeList,
      summary: {
        fileCount: nodes.length,
        skippedCount: files.length - parsed.size, // TypeScript/JavaScript files with syntax errors
        edgeCount: edgeList.length,
        unresolvedCount,
        externalCount,
        assetCount,
        cycleCount: cycles.length,
        languages,
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

/**
 * TypeScript/JavaScript files (TypeScript resolver), files of other supported languages (tree-sitter), and
 * the folders holding a build manifest (services; "" is the root).
 */
export function walk(fs: FileSystemHost, root: string, ignore: IgnoreMatcher): { files: string[]; others: string[]; services: Service[] } {
  const out: string[] = [];
  const others: string[] = [];
  const services: Service[] = [];
  const visit = (dir: string, relDir: string) => {
    const entries = fs.readDirectory(dir).sort((a, b) => cmp(a.name, b.name));
    if (relDir && entries.some((e) => !e.isDirectory && e.name === "pyvenv.cfg")) return; // a Python virtualenv, whatever its name
    const kind = entries.flatMap((e) => (e.isDirectory ? [] : [manifestKind(e.name)])).find(Boolean);
    if (kind) services.push({ path: relDir, kind });
    for (const e of entries) {
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!ALWAYS_IGNORED.has(e.name) && !ignore(relPath, true)) visit(joinPath(dir, e.name), relPath);
      } else if (ignore(relPath, false)) {
        continue;
      } else if (SOURCE_FILE.test(e.name)) {
        if (!DECLARATION_FILE.test(e.name)) out.push(joinPath(dir, e.name));
      } else if (languageForPath(e.name)) {
        others.push(joinPath(dir, e.name));
      }
    }
  };
  visit(root, "");
  return { files: out, others, services };
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

/** The files `analyzeRepo` would look at, so a host can compute tree-sitter facts for `others` first. */
export function listSourceFiles(fs: FileSystemHost, root: string): { files: string[]; others: string[]; services: Service[] } {
  root = root.replace(/\/+$/, "");
  return walk(fs, root, gitignore(fs, root, []));
}

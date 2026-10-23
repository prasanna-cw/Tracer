import type { FileFacts } from "../engine/facts";
import type { LangId } from "../engine/languages";
import { joinPath, type FileSystemHost } from "./fileSystem";

/** A non-TypeScript source file with its tree-sitter facts. Paths: `rel` relative to the root, forward slashes. */
export type FactsFile = { abs: string; rel: string; facts: FileFacts; service: string };
export type Service = { path: string; kind: string };

export type LinkOutput = {
  edge(from: FactsFile, toRel: string): void;
  unresolved(from: FactsFile, specifier: string): void;
  external(): void;
};

// Languages that refer to each other's types by name share an index (Kotlin calls Java classes, etc.).
const FAMILY: Partial<Record<LangId, string>> = {
  java: "jvm", kotlin: "jvm", scala: "jvm", csharp: "dotnet", swift: "swift", php: "php", dart: "dart", ruby: "ruby",
};
const SEPARATOR: Record<string, string> = { jvm: ".", dotnet: ".", php: "\\", swift: ".", dart: ".", ruby: "::" };
const MAX_DIR_EDGES = 50; // Go imports a whole package (directory); cap the fan-out
const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (...parts: string[]): string => normalize(parts.filter(Boolean).join("/"));

/** Folds `.` and `..`; never climbs above the root (returns "" there). */
function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Links non-TypeScript files: by name (JVM, .NET, Swift, PHP, Dart, Ruby type references and qualified
 * imports) and by path (Python modules, Go packages, Rust modules, C/C++ includes, PHP/Ruby requires, Dart URIs).
 */
export function linkFacts(fs: FileSystemHost, root: string, files: readonly FactsFile[], services: readonly Service[], out: LinkOutput): void {
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const filesInDir = new Map<string, FactsFile[]>();
  for (const f of files) {
    const d = dirname(f.rel);
    const list = filesInDir.get(d);
    if (list) list.push(f);
    else filesInDir.set(d, [f]);
  }
  const manifest = memo((path: string) => fs.readFile(joinPath(root, path)) ?? "");

  // ---- name indexes ----------------------------------------------------------------------------
  const names = new Map<string, FactsFile[]>(); // family:Name
  const qualified = new Map<string, FactsFile[]>(); // family:pkg<sep>Name
  const packages = new Map<string, FactsFile[]>(); // family:pkg
  const push = <K>(m: Map<K, FactsFile[]>, k: K, f: FactsFile) => {
    const list = m.get(k);
    if (list) {
      if (!list.includes(f)) list.push(f);
    } else m.set(k, [f]);
  };
  for (const f of files) {
    const fam = FAMILY[f.facts.lang];
    if (!fam) continue;
    if (f.facts.package) push(packages, `${fam}:${f.facts.package}`, f);
    for (const t of f.facts.types) {
      push(names, `${fam}:${t.name}`, f);
      if (f.facts.package) push(qualified, `${fam}:${f.facts.package}${SEPARATOR[fam]}${t.name}`, f);
    }
  }
  const knownPackage = (fam: string, pkg: string) =>
    [...packages.keys()].some((k) => k === `${fam}:${pkg}` || k.startsWith(`${fam}:${pkg}${SEPARATOR[fam]}`) || `${fam}:${pkg}`.startsWith(`${k}${SEPARATOR[fam]}`));

  const linkByName = (f: FactsFile, fam: string) => {
    const own = new Set(f.facts.types.map((t) => t.name));
    const visible = new Set<string>();
    if (f.facts.package) {
      // A file sees its own package; a C# namespace also sees its parents.
      visible.add(f.facts.package);
      if (fam === "dotnet") f.facts.package.split(".").forEach((_, i, a) => visible.add(a.slice(0, i + 1).join(".")));
    }
    for (const spec of f.facts.imports) {
      if (fam === "swift" || fam === "dart" || fam === "ruby") continue; // module imports / handled by path
      if (spec.endsWith(".*")) {
        visible.add(spec.slice(0, -2));
        continue;
      }
      if (fam === "dotnet") {
        visible.add(spec); // `using` names a namespace
        if (!knownPackage(fam, spec)) out.external();
        continue;
      }
      const targets = qualified.get(`${fam}:${spec}`);
      if (targets) {
        for (const t of targets) out.edge(f, t.rel);
        continue;
      }
      const pkg = spec.slice(0, spec.lastIndexOf(SEPARATOR[fam] ?? "."));
      // Inside our own packages but not found: broken. A Kotlin top-level function import of an existing package is fine.
      if (knownPackage(fam, pkg) && !packages.has(`${fam}:${pkg}`)) out.unresolved(f, spec);
      else if (!packages.has(`${fam}:${pkg}`)) out.external();
    }
    for (const ref of f.facts.typeRefs) {
      if (own.has(ref)) continue;
      const candidates = (names.get(`${fam}:${ref}`) ?? []).filter((c) => c !== f);
      if (!candidates.length) continue;
      const inVisible = candidates.filter((c) => c.facts.package !== undefined && visible.has(c.facts.package));
      const sameService = candidates.filter((c) => c.service === f.service);
      const pick = inVisible.length ? inVisible : sameService.length === 1 ? sameService : candidates.length === 1 ? candidates : [];
      for (const t of pick) out.edge(f, t.rel);
    }
  };

  // ---- path resolvers ------------------------------------------------------------------------------
  const serviceOf = (f: FactsFile) => f.service;
  const firstExisting = (candidates: string[]) => candidates.map(normalize).find((c) => byRel.has(c));

  const python = (f: FactsFile, spec: string) => {
    const [modPart, name] = spec.includes(":") ? (spec.split(":") as [string, string]) : [spec, undefined];
    const dots = /^\.*/.exec(modPart)?.[0].length ?? 0;
    const dotted = modPart.slice(dots);
    const asPath = (m: string) => m.split(".").filter(Boolean).join("/");
    let bases: string[];
    if (dots) {
      let base = dirname(f.rel);
      for (let i = 1; i < dots; i++) base = dirname(base);
      bases = [base];
    } else {
      // Package roots: the topmost folder of this file's package chain, the service, service/src, the root.
      let top = dirname(f.rel);
      while (top && byRel.has(join(top, "__init__.py"))) top = dirname(top);
      bases = [...new Set([top, serviceOf(f), join(serviceOf(f), "src"), ""])];
    }
    const modules = name && name !== "*" ? [join(asPath(dotted), name), asPath(dotted)] : [asPath(dotted)];
    for (const base of bases) {
      for (const m of modules) {
        const hit = firstExisting([`${join(base, m)}.py`, join(base, m, "__init__.py")]);
        if (hit) return out.edge(f, hit);
      }
    }
    const head = dotted.split(".")[0] ?? "";
    const ours = dots > 0 || bases.some((b) => byRel.has(join(b, head, "__init__.py")) || byRel.has(`${join(b, head)}.py`));
    if (ours) out.unresolved(f, spec.replace(":*", ""));
    else out.external();
  };

  const goModules = memo(() =>
    services
      .map((s) => ({ dir: s.path, module: /^module\s+(\S+)/m.exec(manifest(join(s.path, "go.mod")))?.[1] }))
      .filter((m): m is { dir: string; module: string } => !!m.module),
  );
  const go = (f: FactsFile, spec: string) => {
    const mod = goModules().find((m) => spec === m.module || spec.startsWith(`${m.module}/`));
    if (!mod) return out.external();
    const dir = join(mod.dir, spec.slice(mod.module.length));
    const targets = (filesInDir.get(dir) ?? []).filter((t) => t.facts.lang === "go" && !t.rel.endsWith("_test.go"));
    if (!targets.length) return out.unresolved(f, spec);
    for (const t of targets.slice(0, MAX_DIR_EDGES)) out.edge(f, t.rel);
  };

  const crateNames = memo(() =>
    new Map(services.flatMap((s) => {
      const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(manifest(join(s.path, "Cargo.toml")))?.[1];
      return name ? [[name.replace(/-/g, "_"), join(s.path, "src")] as const] : [];
    })),
  );
  const rustModuleDir = (rel: string) => {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    return ["mod.rs", "lib.rs", "main.rs"].includes(base) ? dirname(rel) : rel.replace(/\.rs$/, "");
  };
  const rust = (f: FactsFile, spec: string) => {
    if (spec.startsWith("mod:")) {
      const dir = rustModuleDir(f.rel);
      const name = spec.slice(4);
      const hit = firstExisting([`${join(dir, name)}.rs`, join(dir, name, "mod.rs")]);
      return hit ? out.edge(f, hit) : out.unresolved(f, spec);
    }
    for (const path of expandRustUse(spec)) {
      const segs = path.split("::").filter((s) => s && s !== "*");
      const head = segs.shift() ?? "";
      let base: string | undefined;
      if (head === "crate") base = join(serviceOf(f), "src");
      else if (head === "self") base = rustModuleDir(f.rel);
      else if (head === "super") base = dirname(rustModuleDir(f.rel));
      else base = crateNames().get(head);
      if (base === undefined) {
        out.external();
        continue;
      }
      let hit: string | undefined;
      for (let k = segs.length; k > 0 && !hit; k--) {
        const p = join(base, ...segs.slice(0, k));
        hit = firstExisting([`${p}.rs`, join(p, "mod.rs")]);
      }
      hit ??= firstExisting([join(base, "lib.rs"), join(base, "main.rs")]);
      if (hit) out.edge(f, hit);
      else out.unresolved(f, path);
    }
  };

  const includes = (f: FactsFile, spec: string) => {
    const hit = firstExisting([join(dirname(f.rel), spec), join(serviceOf(f), spec), join(serviceOf(f), "include", spec), spec, join("include", spec)]);
    if (hit) return out.edge(f, hit);
    const bySuffix = files.filter((t) => (t.facts.lang === "c" || t.facts.lang === "cpp") && (t.rel === spec || t.rel.endsWith(`/${spec}`)));
    if (bySuffix.length === 1 && bySuffix[0]) out.edge(f, bySuffix[0].rel);
    else out.unresolved(f, spec);
  };

  const pathImport = (f: FactsFile, spec: string, fam: string) => {
    if (fam === "php" && spec.startsWith("path:")) {
      const p = spec.slice(5).replace(/^\//, "");
      const hit = firstExisting([join(dirname(f.rel), p), join(serviceOf(f), p), p]);
      return hit ? out.edge(f, hit) : out.unresolved(f, spec.slice(5));
    }
    if (fam === "ruby") {
      const [kind, p] = [spec.slice(0, 3), spec.slice(4)];
      const withExt = p.endsWith(".rb") ? p : `${p}.rb`;
      const hit =
        kind === "rel"
          ? firstExisting([join(dirname(f.rel), withExt)])
          : firstExisting([join(serviceOf(f), "lib", withExt), join(serviceOf(f), withExt), join("lib", withExt)]);
      if (hit) return out.edge(f, hit);
      return kind === "rel" ? out.unresolved(f, p) : out.external(); // `require "json"`: a gem
    }
    if (fam === "dart") {
      if (spec.startsWith("dart:")) return out.external();
      const pkg = /^package:([^/]+)\/(.+)$/.exec(spec);
      if (pkg) {
        const svc = services.find((s) => new RegExp(`^name:\\s*${pkg[1]}\\s*$`, "m").test(manifest(join(s.path, "pubspec.yaml"))));
        if (!svc) return out.external();
        const hit = firstExisting([join(svc.path, "lib", pkg[2] ?? "")]);
        return hit ? out.edge(f, hit) : out.unresolved(f, spec);
      }
      const hit = firstExisting([join(dirname(f.rel), spec)]);
      return hit ? out.edge(f, hit) : out.unresolved(f, spec);
    }
  };

  for (const f of files) {
    const lang = f.facts.lang;
    const fam = FAMILY[lang];
    if (lang === "python") f.facts.imports.forEach((s) => python(f, s));
    else if (lang === "go") f.facts.imports.forEach((s) => go(f, s));
    else if (lang === "rust") f.facts.imports.forEach((s) => rust(f, s));
    else if (lang === "c" || lang === "cpp") f.facts.imports.forEach((s) => includes(f, s));
    else if (lang === "swift") f.facts.imports.forEach(() => out.external());
    if (fam === "php" || fam === "ruby" || fam === "dart") {
      for (const s of f.facts.imports) {
        if (fam === "php" && !s.startsWith("path:")) continue; // `use` is a qualified name: linked by name below
        pathImport(f, s, fam);
      }
    }
    if (fam) linkByName(f, fam);
  }
}

/** `crate::a::{b, c::D}` -> [`crate::a::b`, `crate::a::c::D`]; drops ` as alias`. One level of braces. */
export function expandRustUse(spec: string): string[] {
  const clean = spec.replace(/\s+as\s+\w+/g, "").replace(/\s+/g, "");
  const m = /^(.*?)::\{(.*)\}$/.exec(clean);
  if (!m) return [clean];
  return (m[2] ?? "").split(",").filter(Boolean).map((part) => (part === "self" ? (m[1] ?? "") : `${m[1]}::${part}`));
}

function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const cache = new Map<string, R>();
  return (...args: A) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args));
    return cache.get(key) as R;
  };
}

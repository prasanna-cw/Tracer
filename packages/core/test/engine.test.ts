import { beforeAll, describe, expect, it } from "vitest";
import { Engine, LANGUAGES, languageForPath, type FileFacts } from "../src/engine";
import { nodeWasm } from "./wasm";

let engine: Engine;
beforeAll(async () => {
  engine = await Engine.create(nodeWasm);
});

const facts = async (path: string, code: string): Promise<FileFacts> => {
  const f = await engine.facts(path, code);
  if (!f) throw new Error(`no facts for ${path}`);
  return f;
};
const fnNames = (f: FileFacts) => f.functions.map((x) => (x.container ? `${x.container}.${x.name}` : x.name));

describe("language registry", () => {
  it("maps extensions to languages", () => {
    expect(["a.ts", "b.tsx", "c.java", "d.kt", "e.py", "f.go", "g.cs", "h.rs", "i.cpp", "j.php", "k.rb", "l.swift", "m.dart", "n.c"].map((p) => languageForPath(p)?.id)).toEqual([
      "typescript", "tsx", "java", "kotlin", "python", "go", "csharp", "rust", "cpp", "php", "ruby", "swift", "dart", "c",
    ]);
    expect(languageForPath("README.md")).toBeUndefined();
  });

  it("loads every grammar it lists", async () => {
    for (const spec of LANGUAGES) expect(await engine.language(spec), spec.id).not.toBeNull();
    expect(engine.failed).toEqual([]);
  });
});

describe("facts per language", () => {
  it("Java: package, imports, types, methods with their class, type references", async () => {
    const f = await facts(
      "RiskService.java",
      `package com.acme.risk;\nimport com.acme.db.RiskRepo;\nimport com.acme.util.*;\npublic class RiskService {\n  private final RiskRepo repo;\n  public RiskService(RiskRepo r) { this.repo = r; }\n  public void save(List<Risk> risks) { repo.saveAll(risks); }\n}\ninterface Auditable {}`,
    );
    expect(f.package).toBe("com.acme.risk");
    expect(f.imports).toEqual(["com.acme.db.RiskRepo", "com.acme.util.*"]);
    expect(f.types.map((t) => `${t.kind}:${t.name}`)).toEqual(["class:RiskService", "interface:Auditable"]);
    expect(fnNames(f)).toEqual(["RiskService.RiskService", "RiskService.save"]);
    expect(f.typeRefs).toEqual(expect.arrayContaining(["RiskRepo", "List", "Risk"]));
    expect(f.syntaxErrors).toBe(false);
  });

  it("Kotlin", async () => {
    const f = await facts("Svc.kt", `package com.acme\nimport com.acme.db.Repo\nclass Svc(private val repo: Repo) {\n  fun save(i: Item): Int { repo.save(i); return 1 }\n}\nobject Registry`);
    expect([f.package, f.imports, f.types.map((t) => t.name), fnNames(f)]).toEqual(["com.acme", ["com.acme.db.Repo"], ["Svc", "Registry"], ["Svc.save"]]);
  });

  it("Python: import forms, classes, methods", async () => {
    const f = await facts("svc.py", `from app.db import repo, models as m\nfrom . import util\nimport os.path\nclass Svc:\n    def save(self, items):\n        return repo.save(items)\ndef helper():\n    pass\n`);
    expect(f.imports).toEqual(["app.db:repo", "app.db:models", ".:util", "os.path"]);
    expect([f.types.map((t) => t.name), fnNames(f)]).toEqual([["Svc"], ["Svc.save", "helper"]]);
  });

  it("Go: package, import paths, funcs and methods", async () => {
    const f = await facts("svc.go", `package svc\nimport (\n  "fmt"\n  db "acme.com/app/db"\n)\ntype Svc struct{}\nfunc (s *Svc) Save() error { fmt.Println(); return nil }\nfunc helper() {}`);
    expect([f.package, f.imports, f.types.map((t) => t.name), fnNames(f)]).toEqual(["svc", ["fmt", "acme.com/app/db"], ["Svc"], ["Save", "helper"]]);
  });

  it("C#: using, namespace, class members", async () => {
    const f = await facts("RiskService.cs", `using Acme.Db;\nnamespace Acme.Risk {\n public class RiskService {\n  private readonly IRepo _repo;\n  public RiskService(IRepo r) { _repo = r; }\n  public void Save() { _repo.Flush(); }\n }\n}`);
    expect([f.package, f.imports, f.types.map((t) => t.name), fnNames(f)]).toEqual(["Acme.Risk", ["Acme.Db"], ["RiskService"], ["RiskService.RiskService", "RiskService.Save"]]);
    expect(f.typeRefs).toContain("IRepo");
  });

  it("Rust: use, mod, items", async () => {
    const f = await facts("lib.rs", `use crate::db::Repo;\nuse std::io;\nmod util;\nmod inline { fn x() {} }\nstruct Svc;\nimpl Svc { fn save(&self) {} }\nfn main() {}`);
    expect(f.imports).toEqual(["crate::db::Repo", "std::io", "mod:util"]);
    expect([f.types.map((t) => t.name), f.functions.map((x) => x.name)]).toEqual([["Svc"], ["x", "save", "main"]]);
  });

  it("C and C++: quoted includes only; function names through declarators", async () => {
    const c = await facts("save.c", `#include "repo.h"\n#include <stdio.h>\nstruct Item { int id; };\nint save(int n) { return n; }`);
    expect([c.imports, c.types.map((t) => t.name), c.functions.map((x) => x.name)]).toEqual([["repo.h"], ["Item"], ["save"]]);
    const cpp = await facts("svc.cpp", `#include "db/repo.h"\nclass Svc { public: void save(); };\nvoid Svc::save() {}`);
    expect([cpp.imports, cpp.types.map((t) => t.name), cpp.functions.map((x) => x.name)]).toEqual([["db/repo.h"], ["Svc"], ["Svc::save"]]);
  });

  it("PHP: namespace, use, require, class methods", async () => {
    const f = await facts("Svc.php", `<?php\nnamespace App\\Services;\nuse App\\Models\\User;\nrequire_once 'helpers.php';\nclass Svc {\n  public function save($u) { return new User(); }\n}`);
    expect([f.package, f.imports, f.types.map((t) => t.name), fnNames(f)]).toEqual(["App\\Services", ["App\\Models\\User", "path:helpers.php"], ["Svc"], ["Svc.save"]]);
  });

  it("Ruby: require vs require_relative, classes, methods", async () => {
    const f = await facts("svc.rb", `require_relative "db/repo"\nrequire "json"\nclass Svc\n  def save(items)\n    Repo.new.save(items)\n  end\nend`);
    expect([f.imports, f.types.map((t) => t.name), fnNames(f)]).toEqual([["rel:db/repo", "lib:json"], ["Svc"], ["Svc.save"]]);
    expect(f.typeRefs).toContain("Repo");
  });

  it("Swift, Scala, Dart: structure", async () => {
    const swift = await facts("Svc.swift", `import Foundation\nclass Svc {\n  func save() -> Int { return 1 }\n}`);
    expect([swift.imports, swift.types.map((t) => t.name), fnNames(swift)]).toEqual([["Foundation"], ["Svc"], ["Svc.save"]]);
    const scala = await facts("Svc.scala", `package acme\nimport acme.db.Repo\nclass Svc(repo: Repo) {\n  def save(i: Int): Int = i\n}`);
    expect([scala.package, scala.imports, scala.types.map((t) => t.name), fnNames(scala)]).toEqual(["acme", ["acme.db.Repo"], ["Svc"], ["Svc.save"]]);
    const dart = await facts("svc.dart", `import 'package:acme/db.dart';\nimport 'util.dart';\nclass Svc {\n  int save(int n) { return n; }\n}`);
    expect([dart.imports, dart.types.map((t) => t.name), fnNames(dart)]).toEqual([["package:acme/db.dart", "util.dart"], ["Svc"], ["Svc.save"]]);
  });

  it("TypeScript: named arrow functions and methods (imports are linked by the TypeScript resolver)", async () => {
    const f = await facts("svc.ts", `export class Svc { save(): void {} }\nexport const helper = async () => {};\nfunction f() {}\nlist.map((x) => x);`);
    expect([f.types.map((t) => t.name), fnNames(f)]).toEqual([["Svc"], ["Svc.save", "helper", "f"]]);
  });

  it("flags syntax errors without failing", async () => {
    const f = await facts("Broken.java", "public class { void x( }");
    expect(f.syntaxErrors).toBe(true);
  });
});

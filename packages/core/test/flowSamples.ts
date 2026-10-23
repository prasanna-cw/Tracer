/**
 * One function per language with the same shape: a loop containing an if/else, a try/catch (where the
 * language has one), a return. `want` is what the generic flow builder must find in each.
 */
export type Sample = { lang: string; file: string; code: string; line: number; want: { loops: number; ifs: number; tries: number; catches: number; switches?: number; ends: number } };

export const SAMPLES: Sample[] = [
  {
    lang: "java", file: "S.java", line: 3, want: { loops: 1, ifs: 1, tries: 1, catches: 1, ends: 2 },
    code: `package a;\npublic class S {\n  void save(List<Risk> risks) {\n    for (Risk r : risks) { if (r.isNew()) { repo.saveAll(r.tags()); } else { log.warn("x"); } }\n    try { repo.flush(); } catch (Exception e) { throw new IllegalStateException(e); } finally { done(); }\n    return;\n  }\n}`,
  },
  {
    lang: "kotlin", file: "S.kt", line: 2, want: { loops: 1, ifs: 1, tries: 1, catches: 1, switches: 1, ends: 2 },
    code: `class Svc {\n  fun save(items: List<Item>): Int {\n    for (i in items) { if (i.ok) repo.save(i) else log.warn("x") }\n    try { repo.flush() } catch (e: Exception) { throw IllegalStateException(e) }\n    when (x) { 1 -> a() else -> b() }\n    return 1\n  }\n}`,
  },
  {
    lang: "python", file: "s.py", line: 2, want: { loops: 1, ifs: 2, tries: 1, catches: 1, ends: 2 },
    code: `class Svc:\n    def save(self, items):\n        for i in items:\n            if i.ok:\n                repo.save(i)\n            elif i.bad:\n                pass\n            else:\n                log.warn("x")\n        try:\n            repo.flush()\n        except Exception as e:\n            raise ValueError(e)\n        return 1\n`,
  },
  {
    lang: "go", file: "s.go", line: 2, want: { loops: 1, ifs: 1, tries: 0, catches: 0, switches: 1, ends: 1 },
    code: `package svc\nfunc (s *Svc) Save(items []Item) error {\n  for _, i := range items { if i.Ok { s.repo.Save(i) } else { fmt.Println("x") } }\n  switch x { case 1: a() }\n  return nil\n}`,
  },
  {
    lang: "csharp", file: "S.cs", line: 2, want: { loops: 1, ifs: 1, tries: 1, catches: 1, ends: 2 },
    code: `class S {\n public void Save(List<Risk> risks) {\n   foreach (var r in risks) { if (r.IsNew) { _repo.SaveAll(r.Tags); } else { Log.Warn("x"); } }\n   try { _repo.Flush(); } catch (Exception e) { throw new InvalidOperationException("x", e); }\n   return;\n } }`,
  },
  {
    lang: "rust", file: "s.rs", line: 2, want: { loops: 1, ifs: 1, tries: 0, catches: 0, switches: 1, ends: 1 },
    code: `impl Svc {\n  fn save(&self, items: Vec<Item>) -> Result<(), E> {\n    for i in items { if i.ok { self.repo.save(i)?; } else { log::warn!("x"); } }\n    match x { 1 => a(), _ => b() }\n    return Ok(());\n  }\n}`,
  },
  {
    lang: "cpp", file: "s.cpp", line: 1, want: { loops: 1, ifs: 1, tries: 1, catches: 1, ends: 2 },
    code: `void Svc::save() {\n  for (auto& i : items) { if (i.ok) { repo.save(i); } else { log("x"); } }\n  try { repo.flush(); } catch (const std::exception& e) { throw; }\n  return;\n}`,
  },
  {
    lang: "php", file: "s.php", line: 4, want: { loops: 1, ifs: 1, tries: 1, catches: 1, ends: 2 },
    code: `<?php\nclass Svc {\n  public function save($items) {\n    foreach ($items as $i) { if ($i->ok) { $this->repo->save($i); } else { log("x"); } }\n    try { $this->repo->flush(); } catch (Exception $e) { throw new RuntimeException("x"); }\n    return 1;\n  }\n}`,
  },
  {
    lang: "ruby", file: "s.rb", line: 2, want: { loops: 0, ifs: 1, tries: 1, catches: 1, ends: 3 },
    code: `class Svc\n  def save(items)\n    if items.empty?\n      return 0\n    else\n      repo.save(items)\n    end\n    begin\n      repo.flush\n    rescue StandardError => e\n      raise e\n    end\n    return 1\n  end\nend`,
  },
  {
    lang: "swift", file: "S.swift", line: 3, want: { loops: 1, ifs: 2, tries: 1, catches: 1, ends: 3 },
    code: `class Svc {\n  func save(items: [Item]) throws -> Int {\n    for i in items { if i.ok { repo.save(i) } else { log("x") } }\n    do { try repo.flush() } catch { throw MyError.bad }\n    guard x else { return 0 }\n    return 1\n  }\n}`,
  },
  {
    lang: "typescript", file: "s.ts", line: 2, want: { loops: 1, ifs: 1, tries: 1, catches: 1, switches: 1, ends: 2 },
    code: `export class Svc {\n  save(items: Item[]): number {\n    for (const i of items) { if (i.ok) { repo.save(i); } else { log("x"); } }\n    try { repo.flush(); } catch (e) { throw new Error("x"); } finally { done(); }\n    switch (x) { case 1: a(); break; default: b(); }\n    return 1;\n  }\n}`,
  },
  {
    lang: "c", file: "s.c", line: 1, want: { loops: 1, ifs: 1, tries: 0, catches: 0, switches: 1, ends: 1 },
    code: `int save(int n) {\n  for (int i = 0; i < n; i++) { if (i) { put(i); } else { log("x"); } }\n  switch (n) { case 1: a(); }\n  return 0;\n}`,
  },
  {
    lang: "scala", file: "S.scala", line: 2, want: { loops: 0, ifs: 1, tries: 0, catches: 0, switches: 1, ends: 0 },
    code: `class Svc {\n  def save(items: List[Item]): Int = {\n    if (items.isEmpty) 0 else repo.save(items)\n    items match { case Nil => a() case _ => b() }\n  }\n}`,
  },
];

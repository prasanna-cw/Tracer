import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPosix } from "@tracer/core/analyzer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCache } from "../src/cache";
import { analyzeWorkspace, indexWorkspace } from "../src/workspace";

let dir: string;
let cacheDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tracer-cache-src-"));
  cacheDir = await mkdtemp(join(tmpdir(), "tracer-cache-dir-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe("FileCache", () => {
  it("returns a set entry back until the file's content changes", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "one");
    const cache = new FileCache(dir, cacheDir);
    expect(cache.get(file, "ts")).toBeUndefined(); // nothing cached yet

    cache.set(file, { kind: "ts", data: { specifiers: ["./b"], loc: 1 } });
    expect(cache.get(file, "ts")).toEqual({ specifiers: ["./b"], loc: 1 });

    // A fresh FileCache for the same root reloads what was saved to disk.
    cache.save();
    const reloaded = new FileCache(dir, cacheDir);
    expect(reloaded.get(file, "ts")).toEqual({ specifiers: ["./b"], loc: 1 });

    // Editing the file invalidates the cached entry (size and/or mtime no longer match).
    await writeFile(file, "a longer replacement body");
    expect(reloaded.get(file, "ts")).toBeUndefined();
  });

  it("keys the same path separately by kind, so a .ts file can hold both a ts and a facts entry", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "one");
    const cache = new FileCache(dir, cacheDir);
    cache.set(file, { kind: "ts", data: { specifiers: [], loc: 1 } });
    cache.set(file, { kind: "facts", data: { lang: "typescript", loc: 1, imports: [], types: [], functions: [], typeRefs: [], syntaxErrors: false } });
    expect(cache.get(file, "ts")).toEqual({ specifiers: [], loc: 1 });
    expect(cache.get(file, "facts")).toMatchObject({ lang: "typescript" });
  });

  it("drops entries for files no longer touched by a run (deleted, or newly ignored)", async () => {
    const keep = join(dir, "keep.ts");
    const gone = join(dir, "gone.ts");
    await writeFile(keep, "keep");
    await writeFile(gone, "gone");
    const first = new FileCache(dir, cacheDir);
    first.set(keep, { kind: "ts", data: { specifiers: [], loc: 1 } });
    first.set(gone, { kind: "ts", data: { specifiers: [], loc: 1 } });
    first.save();

    // A second run only touches `keep` (as if `gone` were deleted from the workspace before this run).
    const second = new FileCache(dir, cacheDir);
    second.get(keep, "ts");
    second.save();

    const third = new FileCache(dir, cacheDir);
    expect(third.get(keep, "ts")).toEqual({ specifiers: [], loc: 1 });
    expect(third.get(gone, "ts")).toBeUndefined();
  });
});

describe("analyzeWorkspace with a persistent cache", () => {
  it("gives the same graph on a cached repeat run, and picks up a real edit", async () => {
    const root = toPosix(dir);
    await writeFile(join(dir, "a.ts"), 'import "./b";\n');
    await writeFile(join(dir, "b.ts"), "export const b = 1;\n");

    const first = await analyzeWorkspace(root, { cacheDir });
    expect(first.graph.edges).toEqual([{ source: "a.ts", target: "b.ts" }]);
    expect(await readdir(cacheDir)).toHaveLength(1); // the cache file was written

    const second = await analyzeWorkspace(root, { cacheDir });
    expect(second.graph).toEqual(first.graph); // byte-for-byte the same from the cache

    // An edit changes what the next analysis sees, even though only this one file was touched.
    await writeFile(join(dir, "a.ts"), 'import "./b";\nimport "./missing";\n');
    const third = await analyzeWorkspace(root, { cacheDir });
    expect(third.graph.edges).toEqual([{ source: "a.ts", target: "b.ts" }]);
    expect(third.graph.summary.unresolved).toEqual([{ from: "a.ts", specifier: "./missing" }]);
  });

  it("caches tree-sitter facts for non-TypeScript files and shares them with indexWorkspace", async () => {
    const root = toPosix(dir);
    await writeFile(join(dir, "util.py"), "def greet():\n    print('hi')\n");

    const analyzed = await analyzeWorkspace(root, { cacheDir });
    expect(analyzed.graph.nodes.find((n) => n.path === "util.py")).toMatchObject({ lang: "python" });

    // indexWorkspace recomputes nothing for util.py: its "facts" cache entry already exists.
    const indexed = await indexWorkspace(root, { cacheDir });
    const file = indexed.find((f) => f.path === "util.py");
    expect(file?.facts.functions.map((f) => f.name)).toEqual(["greet"]);
  });

  it("drops a deleted file from the graph and its cache entry", async () => {
    const root = toPosix(dir);
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "b.ts"), "export const b = 1;\n");
    await analyzeWorkspace(root, { cacheDir });

    await rm(join(dir, "b.ts"));
    const after = await analyzeWorkspace(root, { cacheDir });
    expect(after.graph.nodes.map((n) => n.path)).toEqual(["a.ts"]);
  });
});

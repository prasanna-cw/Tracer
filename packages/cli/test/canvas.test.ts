import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportCanvasFile, importCanvasFile } from "../src/canvas";

const sample = fileURLToPath(new URL("../../../samples/save-flow.diagram.json", import.meta.url));
const readJson = async (p: string): Promise<unknown> => JSON.parse(await readFile(p, "utf8"));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "codemap-cli-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("canvas CLI", () => {
  it("export -> import of save-flow loses nothing", async () => {
    const canvas = join(dir, "save-flow.canvas");
    const back = join(dir, "save-flow.diagram.json");
    await exportCanvasFile(sample, canvas);
    expect(await importCanvasFile(canvas, back)).toEqual([]);
    expect(await readJson(back)).toEqual(await readJson(sample));
  });

  it("reports invalid JSON and invalid diagrams with the file path", async () => {
    const bad = join(dir, "bad.diagram.json");
    await writeFile(bad, "{ nope");
    await expect(exportCanvasFile(bad, join(dir, "x.canvas"))).rejects.toThrow(/Invalid JSON in .*bad\.diagram\.json/);
    await writeFile(bad, JSON.stringify({ version: 1, title: "", nodes: [], edges: [{ id: "e", fromNode: "a", toNode: "b" }] }));
    await expect(exportCanvasFile(bad, join(dir, "x.canvas"))).rejects.toThrow('edges[0].fromNode: unknown node "a"');
  });

  it("accepts files with a UTF-8 BOM", async () => {
    const withBom = join(dir, "bom.diagram.json");
    await writeFile(withBom, "﻿" + (await readFile(sample, "utf8")));
    await expect(exportCanvasFile(withBom, join(dir, "bom.canvas"))).resolves.toEqual([]);
  });

  it("reports a missing input file", async () => {
    await expect(importCanvasFile(join(dir, "missing.canvas"), join(dir, "y.json"))).rejects.toThrow(/Cannot read .*ENOENT/);
  });
});

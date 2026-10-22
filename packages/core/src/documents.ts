import { fromJsonCanvas, toJsonCanvas } from "./canvas-io/jsonCanvas";
import { parseDiagram, type Diagram, type ParseResult } from "./schema/diagram";

/** Diagram documents on disk: `*.canvas` is JSON Canvas (tab-indented, like Obsidian), anything else is native JSON. */
export const isCanvasFile = (name: string): boolean => name.toLowerCase().endsWith(".canvas");

const baseName = (name: string): string => name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);

export function diagramToText(fileName: string, diagram: Diagram): string {
  return isCanvasFile(fileName) ? JSON.stringify(toJsonCanvas(diagram), null, "\t") + "\n" : JSON.stringify(diagram, null, 2) + "\n";
}

export function textToDiagram(fileName: string, text: string): ParseResult<Diagram> {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`], warnings: [] };
  }
  if (isCanvasFile(fileName)) return fromJsonCanvas(json, { title: baseName(fileName).replace(/\.canvas$/i, "") });
  return parseDiagram(json);
}

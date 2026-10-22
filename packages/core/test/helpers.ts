import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const readSample = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../samples/${name}`, import.meta.url)), "utf8"));

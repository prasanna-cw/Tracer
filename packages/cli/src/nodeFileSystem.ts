import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { toPosix, type FileSystemHost } from "@tracer/core/analyzer";

/** node:fs implementation of the analyzer's port. Reads lazily; nothing is cached or preloaded. */
export const nodeFileSystem: FileSystemHost = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  fileExists: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
  directoryExists: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
  readDirectory(path) {
    if (!existsSync(path)) return [];
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((e) => !e.isSymbolicLink()) // avoid symlink loops (pnpm, monorepo links)
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return []; // unreadable directory (permissions): skip rather than abort the whole analysis
    }
  },
  realpath: (path) => toPosix(realpathSync(path)),
};

const PREFETCH_BUDGET = 400 * 1024 * 1024; // characters held in memory at most; the rest is read on demand

/**
 * Reads `paths` with many reads in flight at once. Per-file latency (antivirus scanning, network drives, cold
 * caches) is what makes a big checkout slow to read, and it overlaps well: 6,000 files went from reading
 * one after another to a fraction of that. Unreadable files are simply absent from the result.
 */
export async function prefetch(paths: readonly string[], concurrency = 48): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let next = 0;
  let held = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++] as string;
      if (held > PREFETCH_BUDGET) return;
      try {
        const text = await readFile(path, "utf8");
        held += text.length;
        out.set(path, text);
      } catch {
        // skipped: the analyzer reports it when it reaches the file
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

/** `nodeFileSystem` that answers readFile from `cache` first (everything else goes to disk). */
export function withCache(cache: ReadonlyMap<string, string>): FileSystemHost {
  return { ...nodeFileSystem, readFile: (path) => cache.get(path) ?? nodeFileSystem.readFile(path) };
}

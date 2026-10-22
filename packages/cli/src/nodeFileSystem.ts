import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { toPosix, type FileSystemHost } from "@codemap/core/analyzer";

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

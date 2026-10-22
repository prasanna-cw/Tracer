/**
 * The analyzer's only door to the outside world. The CLI implements it with node:fs; a VS Code host can
 * implement it with workspace.fs; tests use an in-memory map. Files are read on demand, one at a time.
 *
 * All paths are absolute and use forward slashes (`C:/repo/src/a.ts`, `/home/me/repo/src/a.ts`).
 */
export interface FileSystemHost {
  /** File contents, or undefined if it does not exist or cannot be read. */
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  /** Direct children of a directory (no recursion). Empty if the directory does not exist. */
  readDirectory(path: string): { name: string; isDirectory: boolean }[];
  /** Optional: resolve symlinks (used by TypeScript module resolution). */
  realpath?(path: string): string;
}

export const joinPath = (dir: string, name: string): string => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
export const toPosix = (p: string): string => p.replace(/\\/g, "/");

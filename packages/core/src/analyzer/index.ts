// Separate entry (`@codemap/core/analyzer`): it pulls in the TypeScript compiler, which the browser app must never bundle.
export { analyzeRepo, type AnalyzeResult } from "./analyze";
export { joinPath, toPosix, type FileSystemHost } from "./fileSystem";
export { parseGitignore } from "./gitignore";

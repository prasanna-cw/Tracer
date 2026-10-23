// Separate entry (`@tracer/core/analyzer`): it pulls in the TypeScript compiler, which the browser app must never bundle.
export { analyzeRepo, listSourceFiles, type AnalyzeOptions, type AnalyzeResult } from "./analyze";
export { joinPath, toPosix, type FileSystemHost } from "./fileSystem";
export { parseGitignore } from "./gitignore";
export { expandRustUse, type Service } from "./linkFacts";

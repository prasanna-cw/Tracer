// Separate entry (`@tracer/core/engine`): tree-sitter (WASM) parsing for every supported language.
// Kept out of the main entry so the browser bundle never pulls it in unless it asks for it.
export { Engine, type WasmLoader } from "./engine";
export { extractFacts, functionLabel, nameOf, type FileFacts } from "./facts";
export { LANGUAGES, languageById, languageForPath, type LangId, type LanguageSpec, type TypeKind } from "./languages";
export { cleanCallee } from "./callee";
export { buildFlow, type CallResolver, type CallTarget, type FlowOutcome, type FlowRequest } from "./flow";
export { buildFunctionIndex, callTrace, fileOverview, roleOf, type FunctionIndex, type IndexedFile } from "./overview";

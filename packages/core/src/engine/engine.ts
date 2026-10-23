import { Language, Parser, type Tree } from "web-tree-sitter";
import { extractFacts, type FileFacts } from "./facts";
import { buildFlow, type CallResolver, type FlowOutcome, type FlowRequest } from "./flow";
import { languageForPath, type LangId, type LanguageSpec } from "./languages";

/** Supplies WASM bytes by file name: "tree-sitter.wasm" (runtime) or "tree-sitter-<grammar>.wasm". */
export type WasmLoader = (file: string) => Uint8Array | Promise<Uint8Array>;

let runtime: Promise<void> | undefined;

/**
 * Parses any supported language with tree-sitter (WASM). The host supplies the WASM bytes, so this runs
 * the same in Node, a worker thread or a browser. Grammars load lazily, once, on first use.
 */
export class Engine {
  private readonly languages = new Map<LangId, Promise<Language | null>>();
  private readonly parser = new Parser();
  readonly failed: string[] = [];

  private constructor(private readonly load: WasmLoader) {}

  static async create(load: WasmLoader): Promise<Engine> {
    runtime ??= (async () => {
      const wasmBinary = await load("tree-sitter.wasm");
      await Parser.init({ wasmBinary } as Parameters<typeof Parser.init>[0]);
    })();
    await runtime;
    return new Engine(load);
  }

  /** The grammar, or null if it could not be loaded (the file is then listed without internals). */
  language(spec: LanguageSpec): Promise<Language | null> {
    let lang = this.languages.get(spec.id);
    if (!lang) {
      lang = (async () => {
        try {
          return await Language.load(await this.load(`tree-sitter-${spec.grammar}.wasm`));
        } catch (e) {
          this.failed.push(`${spec.name}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      })();
      this.languages.set(spec.id, lang);
    }
    return lang;
  }

  /** Parses `text`; the caller must `tree.delete()` (WASM memory is not garbage collected). */
  async parse(spec: LanguageSpec, text: string): Promise<Tree | null> {
    const lang = await this.language(spec);
    if (!lang) return null;
    this.parser.setLanguage(lang);
    return this.parser.parse(text);
  }

  /** A control-flow diagram of a function or a selection, or the reason there is none. */
  async flow(path: string, text: string, req: FlowRequest, resolve: CallResolver): Promise<FlowOutcome> {
    const spec = languageForPath(path);
    if (!spec) return { ok: false, reason: `Tracer does not read ${path.slice(path.lastIndexOf(".")) || "this kind of"} files.` };
    const tree = await this.parse(spec, text);
    if (!tree) return { ok: false, reason: `The ${spec.name} parser could not be loaded.` };
    try {
      return buildFlow(spec, tree.rootNode, text, path, req, resolve);
    } finally {
      tree.delete();
    }
  }

  /** Facts for one file, or undefined for files of unsupported languages. */
  async facts(path: string, text: string): Promise<FileFacts | undefined> {
    const spec = languageForPath(path);
    if (!spec) return undefined;
    const tree = await this.parse(spec, text);
    if (!tree) return undefined;
    try {
      return extractFacts(spec, tree.rootNode, text);
    } finally {
      tree.delete();
    }
  }
}

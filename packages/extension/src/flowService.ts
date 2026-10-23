import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import type { Diagram } from "@tracer/core";
import {
  buildFunctionIndex,
  callTrace,
  Engine,
  fileOverview,
  LANGUAGES,
  languageForPath,
  type FunctionIndex,
  type IndexedFile,
} from "@tracer/core/engine";
import type { WorkerMessage } from "./analyzerWorker";

export type FlowTarget =
  | { kind: "file" }
  | { kind: "function"; line: number; column: number }
  | { kind: "selection"; startLine: number; endLine: number }
  | { kind: "trace"; line: number };

export type FlowResult = { ok: true; diagram: Diagram; truncated: boolean; root: vscode.Uri } | { ok: false; reason: string };

const SOURCE_GLOB = `**/*.{${LANGUAGES.flatMap((l) => l.extensions.map((e) => e.slice(1))).join(",")}}`;
const IGNORED = /(^|[\\/])(node_modules|dist|build|\.git|coverage|target|vendor|__pycache__)([\\/]|$)/;
const toPosix = (p: string): string => p.split("\\").join("/");

/**
 * Builds flow diagrams for the files of open workspaces. One index per workspace root (every function and
 * type, built once in a worker thread, then kept fresh by a file watcher) lets calls resolve across files;
 * the file being flowed is always re-parsed from the editor's text, so unsaved changes show up.
 */
export class FlowService implements vscode.Disposable {
  private engine?: Promise<Engine>;
  private readonly indexes = new Map<string, Promise<Map<string, IndexedFile>>>();
  private readonly stale = new Set<string>(); // absolute fs paths changed since the index was built
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    const touch = (uri: vscode.Uri) => !IGNORED.test(uri.fsPath) && this.stale.add(uri.fsPath);
    this.watcher.onDidChange(touch);
    this.watcher.onDidCreate(touch);
    this.watcher.onDidDelete(touch);
  }

  dispose(): void {
    this.watcher.dispose();
  }

  private grammars(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, "dist", "grammars");
  }

  getEngine(): Promise<Engine> {
    this.engine ??= Engine.create((file) => readFileSync(vscode.Uri.joinPath(this.grammars(), file).fsPath));
    return this.engine;
  }

  /** The workspace folder holding `uri`; a file outside every folder is its own little workspace. */
  rootFor(uri: vscode.Uri): vscode.Uri {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri ?? vscode.Uri.joinPath(uri, "..");
  }

  private build(root: vscode.Uri): Promise<Map<string, IndexedFile>> {
    return Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Tracer: indexing ${root.path.slice(root.path.lastIndexOf("/") + 1)}`,
        },
        () =>
          new Promise<Map<string, IndexedFile>>((resolve, reject) => {
            const worker = new Worker(vscode.Uri.joinPath(this.context.extensionUri, "dist", "analyzerWorker.js").fsPath, {
              workerData: { mode: "index", root: toPosix(root.fsPath), wasmDir: this.grammars().fsPath },
            });
            worker.on("message", (m: WorkerMessage) => {
              if (m.kind !== "indexed") return;
              void worker.terminate();
              if (!m.ok) return reject(new Error(m.error));
              this.output.appendLine(`[flow] indexed ${root.fsPath}: ${m.files.length} files in ${m.ms} ms`);
              resolve(new Map((m.files as IndexedFile[]).map((f) => [f.path, f])));
            });
            worker.once("error", reject);
          }),
      ),
    );
  }

  /** Re-parses files that changed since the index was built (cheap: one file at a time, on this thread). */
  private async refresh(root: vscode.Uri, files: Map<string, IndexedFile>): Promise<void> {
    const prefix = `${toPosix(root.fsPath)}/`;
    const engine = await this.getEngine();
    for (const abs of [...this.stale]) {
      const posix = toPosix(abs);
      if (!posix.startsWith(prefix)) continue;
      this.stale.delete(abs);
      const rel = posix.slice(prefix.length);
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(abs)));
        const facts = await engine.facts(rel, text);
        if (facts) files.set(rel, { path: rel, facts, service: files.get(rel)?.service ?? nearestService(files, rel) });
        else files.delete(rel);
      } catch {
        files.delete(rel); // deleted or unreadable
      }
    }
  }

  private async indexFor(root: vscode.Uri): Promise<Map<string, IndexedFile>> {
    const key = root.toString();
    let pending = this.indexes.get(key);
    if (!pending) {
      pending = this.build(root);
      this.indexes.set(key, pending);
      pending.catch(() => this.indexes.delete(key)); // a failed build can be retried
    }
    const files = await pending;
    await this.refresh(root, files);
    return files;
  }

  /** The diagram for `target` in the document at `uri`, using `text` (the editor's current content). */
  async flow(uri: vscode.Uri, text: string, target: FlowTarget, traceDepth: number): Promise<FlowResult> {
    if (!languageForPath(uri.path)) {
      return { ok: false, reason: `Tracer cannot read ${uri.path.slice(uri.path.lastIndexOf(".")) || "this"} files yet.` };
    }
    const root = this.rootFor(uri);
    const rootRel = uri.path.startsWith(`${root.path}/`)
      ? uri.path.slice(root.path.length + 1)
      : uri.path.slice(uri.path.lastIndexOf("/") + 1);
    const engine = await this.getEngine();
    const base = await this.indexFor(root);
    const files = new Map(base);
    const facts = await engine.facts(rootRel, text);
    if (facts) files.set(rootRel, { path: rootRel, facts, service: base.get(rootRel)?.service ?? nearestService(base, rootRel) });
    const index: FunctionIndex = buildFunctionIndex(files.values());

    if (target.kind === "file") {
      const file = files.get(rootRel);
      if (!file) return { ok: false, reason: "This file could not be read." };
      const r = fileOverview(file, index);
      return r.ok ? { ok: true, diagram: r.diagram, truncated: false, root } : r;
    }
    if (target.kind === "trace") {
      const r = callTrace(index, { path: rootRel, line: target.line }, traceDepth);
      return r.ok ? { ok: true, diagram: r.diagram, truncated: r.truncated, root } : r;
    }
    const r = await engine.flow(rootRel, text, target, index.resolve);
    return r.ok ? { ok: true, diagram: r.diagram, truncated: r.truncated, root } : r;
  }
}

/** A file's service when it is new: that of a sibling file in the same folder, else the root's. */
function nearestService(files: Map<string, IndexedFile>, rel: string): string {
  const dir = rel.slice(0, rel.lastIndexOf("/") + 1);
  for (const f of files.values()) if (dir && f.path.startsWith(dir)) return f.service;
  return "";
}

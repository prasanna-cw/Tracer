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
  | { kind: "trace"; line: number; column: number };

/**
 * `partial`: the workspace index was not ready, so calls into other files are not linked yet.
 * `warning`: something about the result the user should know (the code does not parse).
 */
export type FlowResult =
  | { ok: true; diagram: Diagram; truncated: boolean; root: vscode.Uri; partial: boolean; warning?: string }
  | { ok: false; reason: string; cancelled?: true };

/** Every source extension Tracer reads, for a file watcher glob. Shared with graphPanel's live refresh. */
export const SOURCE_GLOB = `**/*.{${LANGUAGES.flatMap((l) => l.extensions.map((e) => e.slice(1))).join(",")}}`;
// Matched against the path inside the workspace, so a workspace that itself lives under `build/` still refreshes.
export const IGNORED = /(^|[\\/])(node_modules|dist|build|\.git|coverage|target|vendor|__pycache__|\.venv|venv|site-packages|\.tox|\.next|\.nuxt|\.gradle)([\\/]|$)/;
const toPosix = (p: string): string => p.split("\\").join("/");
const NO_INDEX = new Map<string, IndexedFile>();

/**
 * Builds flow diagrams for the files of open workspaces. One index per workspace folder (every function and
 * type, built once in a worker thread, then kept fresh by a file watcher) lets calls resolve across files;
 * the file being flowed is always re-parsed from the editor's text, so unsaved changes show up.
 *
 * Only Trace Calls waits for the index. Every other flow is drawn at once from the file itself, with whatever
 * index is ready; the index builds in the background and links calls from the next flow on.
 */
export class FlowService implements vscode.Disposable {
  private engine?: Promise<Engine>;
  private readonly indexes = new Map<string, Promise<Map<string, IndexedFile>>>();
  private readonly ready = new Map<string, Map<string, IndexedFile>>();
  private readonly stale = new Set<string>(); // absolute fs paths changed since the index was built
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
    const touch = (uri: vscode.Uri) => !IGNORED.test(vscode.workspace.asRelativePath(uri, false)) && this.stale.add(uri.fsPath);
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
    this.engine ??= Engine.create((file) => readFileSync(vscode.Uri.joinPath(this.grammars(), file).fsPath)).catch((e: unknown) => {
      this.engine = undefined; // let the next flow try again instead of failing the same way all session
      throw e;
    });
    return this.engine;
  }

  /** The workspace folder holding `uri`; a file outside every folder is its own root and is never indexed. */
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
            worker.once("exit", (code) => reject(new Error(`the indexer stopped (exit code ${code})`))); // no-op once settled
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

  /** The index of a workspace folder, building it on first use (a failed build is retried next time). */
  private indexFor(root: vscode.Uri): Promise<Map<string, IndexedFile>> {
    const key = root.toString();
    let pending = this.indexes.get(key);
    if (!pending) {
      pending = this.build(root);
      this.indexes.set(key, pending);
      pending.then(
        (files) => this.ready.set(key, files),
        (e: unknown) => {
          this.indexes.delete(key);
          this.output.appendLine(`[flow] indexing ${root.fsPath} failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    }
    return pending;
  }

  /**
   * The index if it is built (fresh). Otherwise the build starts and gets a short grace period, which is all a
   * small workspace needs; a big one is used from the next flow on, so a flow never waits for the whole index.
   */
  private async indexNow(root: vscode.Uri, graceMs = 2000): Promise<Map<string, IndexedFile> | undefined> {
    if (!this.ready.has(root.toString())) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.indexFor(root).catch(() => undefined), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
      clearTimeout(timer);
    }
    const files = this.ready.get(root.toString());
    if (files) await this.refresh(root, files);
    return files;
  }

  /** Waits for the index, with a notification the user can cancel (Trace Calls needs every file). */
  private async indexWaiting(root: vscode.Uri): Promise<Map<string, IndexedFile> | undefined> {
    const known = await this.indexNow(root);
    if (known) return known;
    const name = root.path.slice(root.path.lastIndexOf("/") + 1);
    const files = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Tracer: reading ${name} to trace calls across files…`, cancellable: true },
      (_progress, token) =>
        new Promise<Map<string, IndexedFile> | undefined>((resolve, reject) => {
          token.onCancellationRequested(() => resolve(undefined));
          this.indexFor(root).then(resolve, reject);
        }),
    );
    if (files) await this.refresh(root, files);
    return files;
  }

  /** The diagram for `target` in the document at `uri`, using `text` (the editor's current content). */
  async flow(uri: vscode.Uri, text: string, target: FlowTarget, traceDepth: number, fallback?: FlowTarget): Promise<FlowResult> {
    if (!languageForPath(uri.path)) return { ok: false, reason: unsupported(uri) };
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const root = this.rootFor(uri);
    const rootRel = folder && uri.path.startsWith(`${root.path}/`) ? uri.path.slice(root.path.length + 1) : uri.path.slice(uri.path.lastIndexOf("/") + 1);
    const engine = await this.getEngine();
    // A file outside every workspace folder: just that file (indexing its folder could mean the whole Desktop).
    const base = !folder ? NO_INDEX : target.kind === "trace" ? await this.indexWaiting(root) : ((await this.indexNow(root)) ?? NO_INDEX);
    if (!base) return { ok: false, reason: "Cancelled.", cancelled: true }; // only Trace Calls waits, and the user stopped it
    const key = root.toString();
    const partial = !!folder && this.indexes.has(key) && !this.ready.has(key); // a build is running (a failed one is forgotten)
    const files = new Map(base);
    const facts = await engine.facts(rootRel, text);
    if (facts) files.set(rootRel, { path: rootRel, facts, service: base.get(rootRel)?.service ?? nearestService(base, rootRel) });
    const index: FunctionIndex = buildFunctionIndex(files.values());

    if (target.kind === "file") {
      const file = files.get(rootRel);
      if (!file) return { ok: false, reason: "This file could not be read." };
      const r = fileOverview(file, index);
      return r.ok ? { ok: true, diagram: r.diagram, truncated: r.truncated, root, partial } : r;
    }
    if (target.kind === "trace") {
      // The same cursor rules as a function flow (decorator lines, callbacks), then the trace from that function.
      const fn = await engine.functionAt(rootRel, text, target.line, target.column);
      const r = callTrace(index, { path: rootRel, line: fn?.line ?? target.line }, traceDepth);
      return r.ok ? { ok: true, diagram: r.diagram, truncated: r.truncated, root, partial } : r;
    }
    const r = await engine.flow(rootRel, text, target, index.resolve);
    if (!r.ok && fallback?.kind === "file") {
      // Nothing to draw for the cursor (no function): the file's overview, from the index already in hand.
      const file = files.get(rootRel);
      const o = file && fileOverview(file, index);
      if (o?.ok) return { ok: true, diagram: o.diagram, truncated: o.truncated, root, partial };
    }
    return r.ok ? { ok: true, diagram: r.diagram, truncated: r.truncated, root, partial, warning: r.warning } : r;
  }
}

function unsupported(uri: vscode.Uri): string {
  if (uri.scheme === "untitled") return "Save the file first, so Tracer knows its language.";
  const name = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `Tracer cannot read ${name.slice(dot)} files yet.` : `Tracer cannot tell the language of "${name}" (no file extension).`;
}

/** A file's service when it is new: that of a sibling file in the same folder, else the root's. */
function nearestService(files: Map<string, IndexedFile>, rel: string): string {
  const dir = rel.slice(0, rel.lastIndexOf("/") + 1);
  for (const f of files.values()) if (dir && f.path.startsWith(dir)) return f.service;
  return "";
}

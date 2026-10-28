// Integration tests, run inside a real VS Code by @vscode/test-electron (see runTests.ts).
// Workspace: samples/polyglot (so Show Flow resolves calls across its services). A tiny harness instead of mocha: run each test, report, fail if any failed.
import * as assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import type { CodeGraphSummary } from "@tracer/core";

type Api = { statusOf(uri: string): { state: string; nodeCount?: number; detail?: string } | undefined };

const repo = resolve(__dirname, "../../../..");
const EXTENSION_ID = "PrasannaMurugan.tracer-code-flow";

async function waitFor<T>(what: string, get: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function run(): Promise<void> {
  const failures: string[] = [];
  const test = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures.push(name);
      console.error(`  FAIL ${name}\n${e instanceof Error ? e.stack : String(e)}`);
    }
  };
  const ext = vscode.extensions.getExtension<Api>(EXTENSION_ID);
  assert.ok(ext, `${EXTENSION_ID} is not installed in the test instance`);

  await test("is not activated just by opening a workspace", async () => {
    assert.equal(ext.isActive, false);
  });

  await test("Open Graph on a folder activates the extension and analyzes it (samples/demo-repo)", async () => {
    const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openGraph", vscode.Uri.file(join(repo, "samples", "demo-repo")));
    assert.equal(ext.isActive, true);
    assert.ok(summary, "the command returned no summary");
    assert.deepEqual(
      [summary.fileCount, summary.skippedCount, summary.edgeCount, summary.unresolvedCount, summary.externalCount, summary.cycleCount],
      [26, 1, 29, 3, 5, 1],
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("Open Graph live-refreshes when a file is added, without rerunning the command", async () => {
    // Under the open workspace folder, not an external temp dir: VS Code's recursive watcher does not
    // reliably cover paths outside the workspace, so a folder out there would never see the change land.
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(base, "no workspace folder is open");
    const dir = join(base.fsPath, "tracer-live-tmp");
    try {
      cpSync(join(repo, "samples", "demo-repo"), dir, { recursive: true });
      const uri = vscode.Uri.file(dir);
      const key = uri.toString();

      const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openGraph", uri);
      assert.ok(summary, "the command returned no summary");
      assert.equal(ext.exports.statusOf(key)?.nodeCount, summary.fileCount);

      writeFileSync(join(dir, "src", "extra.ts"), "export const extra = 1;\n");
      const refreshed = await waitFor(
        "the background refresh to see the new file",
        () => {
          const s = ext.exports.statusOf(key);
          return s && s.nodeCount === summary.fileCount + 1 ? s : undefined;
        },
        30_000,
      );
      assert.equal(refreshed.state, "loaded");

      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      assert.equal(ext.exports.statusOf(key), undefined, "the status is cleared once the panel closes");
    } finally {
      // If a wait above threw, the panel was never closed, so its cancellation token was never fired: a
      // background refresh can still be mid-read. Closing first lets that worker's read handles release
      // before rmSync runs; retrying rides out the rest (Windows/antivirus can hold a brief lock on a file
      // that was just read — D34).
      try {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      } catch {
        // already closed, or nothing to close
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch (e) {
          // Never throw from a finally (it would mask the test's real outcome, D36): log and move on.
          if (attempt === 9) console.error(`[e2e] could not fully clean up ${dir}: ${e instanceof Error ? e.message : String(e)}`);
          else await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  });

  await test("Open Graph on the workspace analyzes every language (samples/polyglot: 10 services, 10 languages)", async () => {
    const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openGraph");
    assert.ok(summary, "the command returned no summary");
    assert.deepEqual([summary.fileCount, summary.edgeCount, summary.unresolvedCount], [35, 23, 0]);
    assert.equal(Object.keys(summary.languages ?? {}).length, 12); // +1: markdown, now indexed as a doc node
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("Open Map shows the workspace as a map (same analysis as the graph)", async () => {
    const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openMap");
    assert.ok(summary, "the command returned no summary");
    assert.deepEqual([summary.fileCount, summary.edgeCount], [35, 23]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("New ADR writes a numbered file from the template, and the next one increments", async () => {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(base, "no workspace folder is open");
    const dir = vscode.Uri.joinPath(base, "docs", "adr");
    try {
      const uri = await vscode.commands.executeCommand<vscode.Uri | undefined>("tracer.newAdr", "Use a message queue");
      assert.ok(uri, "no ADR file was created");
      assert.match(uri.path, /0001-use-a-message-queue\.md$/);
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      assert.match(text, /^# 0001\. Use a message queue/);
      assert.match(text, /Status: Proposed/);

      const uri2 = await vscode.commands.executeCommand<vscode.Uri | undefined>("tracer.newAdr", "Pick a database");
      assert.match(uri2?.path ?? "", /0002-pick-a-database\.md$/);

      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    } finally {
      try {
        await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
      } catch {
        // nothing was created to clean up
      }
    }
  });

  await test("opens save-flow.diagram.json in the Tracer editor and the webview renders it", async () => {
    const uri = vscode.Uri.file(join(repo, "samples", "save-flow.diagram.json"));
    await vscode.commands.executeCommand("vscode.openWith", uri, "tracer.flowEditor");
    const status = await waitFor("the webview to report", () => ext.exports.statusOf(uri.toString()));
    assert.deepEqual({ state: status.state, nodeCount: status.nodeCount }, { state: "loaded", nodeCount: 16 }, status.detail);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("opens a .canvas file in the same editor (JSON Canvas import)", async () => {
    const uri = vscode.Uri.file(join(repo, "samples", "architecture.canvas"));
    await vscode.commands.executeCommand("vscode.openWith", uri, "tracer.flowEditor");
    const status = await waitFor("the webview to report", () => ext.exports.statusOf(uri.toString()));
    assert.deepEqual({ state: status.state, nodeCount: status.nodeCount }, { state: "loaded", nodeCount: 7 }, status.detail);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("an invalid document is reported as an error, not a blank canvas", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tracer-")), "broken.diagram.json");
    writeFileSync(file, JSON.stringify({ version: 1, title: "x", nodes: [], edges: [{ id: "e", fromNode: "a", toNode: "b" }] }));
    const uri = vscode.Uri.file(file);
    await vscode.commands.executeCommand("vscode.openWith", uri, "tracer.flowEditor");
    const status = await waitFor("the webview to report", () => ext.exports.statusOf(uri.toString()));
    assert.equal(status.state, "error");
    assert.match(status.detail ?? "", /unknown node "a"/);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  // ---- Show Flow -------------------------------------------------------------------------------------------
  // URIs come from the workspace folder: the test window is opened through a junction (spaces in the checkout path),
  // while __dirname is the real path, and a file is "inside the workspace" only by the folder's own path.
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(join(repo, "samples", "polyglot"));
  const CONTROLLER = vscode.Uri.joinPath(workspace, "orders-java", "src", "main", "java", "com", "acme", "orders", "web", "OrderController.java");
  type FlowResult = { ok: true; title: string; nodeCount: number; titles: string[]; truncated: boolean; id: string } | { ok: false; reason: string };
  const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand<FlowResult>(command, ...args);
  const place = async () => {
    const editor = await vscode.window.showTextDocument(CONTROLLER);
    editor.selection = new vscode.Selection(15, 12, 15, 12); // inside OrderController.place
    return editor;
  };
  const rendered = async (r: FlowResult) => {
    assert.ok(r.ok, r.ok ? "" : r.reason);
    const status = await waitFor("the flow webview to report", () => ext.exports.statusOf(r.id));
    assert.deepEqual({ state: status.state, nodeCount: status.nodeCount }, { state: "loaded", nodeCount: r.nodeCount }, status.detail);
    return r;
  };

  await test("Show Flow of a function: opens beside the code and renders", async () => {
    await place();
    const r = await rendered(await run("tracer.showFunctionFlow"));
    assert.equal(r.ok && r.title, "OrderController.place");
    assert.equal(r.ok && r.nodeCount, 4); // start, if, throw, return service.place(...)
    assert.ok(vscode.window.tabGroups.all.length >= 2, "the flow opens in a second editor group, beside the code");
  });

  await test("Show Flow of a selection draws only those lines", async () => {
    const editor = await place();
    editor.selection = new vscode.Selection(15, 0, 17, 0); // the `if` that guards qty
    const r = await rendered(await run("tracer.showFlow"));
    assert.ok(r.ok && /lines 16–17/.test(r.title), JSON.stringify(r));
  });

  await test("Show Flow with the cursor in a function (no selection) draws that function", async () => {
    await place();
    const r = await rendered(await run("tracer.showFlow"));
    assert.equal(r.ok && r.title, "OrderController.place");
  });

  await test("Show Flow on a selected function header draws the function, not one card", async () => {
    const editor = await place();
    editor.selection = new vscode.Selection(13, 18, 13, 23); // double-clicked `place`
    const r = await rendered(await run("tracer.showFlow"));
    assert.equal(r.ok && r.title, "OrderController.place");
    assert.equal(r.ok && r.nodeCount, 4);
  });

  await test("Show Flow outside any function gives the file overview", async () => {
    const editor = await place();
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const r = await rendered(await run("tracer.showFlow"));
    assert.equal(r.ok && r.title, "OrderController.java");
  });

  await test("Trace Calls follows the call chain across files (Controller -> Service -> Repository)", async () => {
    await place();
    const r = await rendered(await run("tracer.traceCalls"));
    assert.equal(r.ok && r.title, "Calls from OrderController.place");
    assert.ok(r.ok && r.nodeCount >= 5, `expected at least 5 functions, got ${JSON.stringify(r)}`);
  });

  await test("Show Flow from the explorer menu (a file, not the active editor)", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const r = await rendered(await run("tracer.showFlow", CONTROLLER));
    assert.equal(r.ok && r.title, "OrderController.java");
  });

  await test("unsupported files and empty spots answer politely instead of failing", async () => {
    const doc = await vscode.workspace.openTextDocument({ content: "just words", language: "markdown" });
    await vscode.window.showTextDocument(doc);
    const r = await run("tracer.showFlow");
    assert.equal(r.ok, false);
    await place();
    const top = vscode.window.activeTextEditor;
    if (top) top.selection = new vscode.Selection(0, 0, 0, 0); // package line: not inside a function
    const none = await run("tracer.showFunctionFlow");
    assert.deepEqual(none, { ok: false, reason: "There is no function at the cursor. Click inside a function and try again." });
  });

  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join("; ")}`);
}

// Integration tests, run inside a real VS Code by @vscode/test-electron (see runTests.ts).
// Workspace: samples/polyglot (so Show Flow resolves calls across its services). A tiny harness instead of mocha: run each test, report, fail if any failed.
import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
      [25, 1, 29, 3, 5, 1],
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("Open Graph on the workspace analyzes every language (samples/polyglot: 10 services, 10 languages)", async () => {
    const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openGraph");
    assert.ok(summary, "the command returned no summary");
    assert.deepEqual([summary.fileCount, summary.edgeCount, summary.unresolvedCount], [34, 23, 0]);
    assert.equal(Object.keys(summary.languages ?? {}).length, 11);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  await test("Open Map shows the workspace as a map (same analysis as the graph)", async () => {
    const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openMap");
    assert.ok(summary, "the command returned no summary");
    assert.deepEqual([summary.fileCount, summary.edgeCount], [34, 23]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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

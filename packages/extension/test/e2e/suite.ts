// Integration tests, run inside a real VS Code by @vscode/test-electron (see runTests.ts).
// Workspace: samples/demo-repo. A tiny harness instead of mocha: run each test, report, fail if any failed.
import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import type { CodeGraphSummary } from "@tracer/core";

type Api = { statusOf(uri: string): { state: string; nodeCount?: number; detail?: string } | undefined };

const repo = resolve(__dirname, "../../../..");
const EXTENSION_ID = "todo-publisher.tracer";

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

  await test("Open Graph View activates the extension and analyzes the workspace (samples/demo-repo)", async () => {
    const summary = await vscode.commands.executeCommand<CodeGraphSummary | undefined>("tracer.openGraph");
    assert.equal(ext.isActive, true);
    assert.ok(summary, "the command returned no summary");
    assert.deepEqual(
      [summary.fileCount, summary.skippedCount, summary.edgeCount, summary.unresolvedCount, summary.externalCount, summary.cycleCount],
      [25, 1, 29, 3, 5, 1],
    );
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

  if (failures.length) throw new Error(`${failures.length} integration test(s) failed: ${failures.join("; ")}`);
}

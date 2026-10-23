import { describe, expect, it } from "vitest";
import { parseToWebview, type Diagram } from "@tracer/core";
import { buildWebviewHtml } from "../src/html";
import { serve, type Handlers } from "../src/rpc";

/** A fake webview: tests push messages in and read what the server posted back. */
function fakeChannel() {
  let listener: ((m: unknown) => unknown) | undefined;
  const posted: unknown[] = [];
  return {
    channel: {
      onDidReceiveMessage: (l: (m: unknown) => unknown) => {
        listener = l;
        return { dispose: () => (listener = undefined) };
      },
      postMessage: async (m: unknown) => {
        posted.push(m);
        return true;
      },
    },
    send: async (m: unknown) => {
      await listener?.(m);
    },
    posted,
  };
}

const diagram: Diagram = { version: 1, title: "t", nodes: [], edges: [] };
const fail = async (): Promise<never> => {
  throw new Error("boom");
};
const handlers = (overrides: Partial<Handlers> = {}): Handlers => ({
  init: async () => ({ mode: "editor", documentId: "doc", theme: "light", native: true }),
  loadDiagram: async () => diagram,
  saveDiagram: async () => null,
  applyEdit: async () => null,
  runCommand: async () => null,
  loadGraph: fail,
  openSource: async () => null,
  listDiagrams: async () => [],
  exportFile: async () => null,
  reportStatus: async () => null,
  ...overrides,
});

describe("rpc server (extension side)", () => {
  it("answers valid requests with validated responses", async () => {
    const f = fakeChannel();
    serve(f.channel, handlers(), () => undefined);
    await f.send({ kind: "request", id: 1, method: "loadDiagram", params: { id: "doc" } });
    expect(f.posted).toEqual([{ kind: "response", id: 1, ok: true, result: diagram }]);
    expect(parseToWebview(f.posted[0]).ok).toBe(true);
  });

  it("turns handler errors into error responses", async () => {
    const f = fakeChannel();
    serve(f.channel, handlers(), () => undefined);
    await f.send({ kind: "request", id: 2, method: "loadGraph", params: {} });
    expect(f.posted).toEqual([{ kind: "response", id: 2, ok: false, error: "boom" }]);
  });

  it("rejects invalid messages without calling any handler, and logs them", async () => {
    const f = fakeChannel();
    const logs: string[] = [];
    let called = false;
    serve(
      f.channel,
      handlers({
        openSource: async () => {
          called = true;
          return null;
        },
      }),
      (m) => logs.push(m),
    );
    await f.send({ kind: "request", id: 3, method: "openSource", params: { path: 42 } });
    await f.send("not even an object");
    expect(called).toBe(false);
    expect(f.posted).toEqual([{ kind: "response", id: 3, ok: false, error: expect.stringMatching(/^invalid request: params\.path: /) }]);
    expect(logs).toHaveLength(2);
  });

  it("never sends a malformed result: a buggy handler becomes an error response", async () => {
    const f = fakeChannel();
    serve(f.channel, handlers({ loadDiagram: async () => ({ nope: 1 }) as unknown as Diagram }), () => undefined);
    await f.send({ kind: "request", id: 4, method: "loadDiagram", params: { id: "doc" } });
    expect(f.posted[0]).toMatchObject({ id: 4, ok: false });
  });

  it("validates events before posting them", () => {
    const f = fakeChannel();
    const server = serve(f.channel, handlers(), () => undefined);
    server.emit({ kind: "event", type: "theme", theme: "dark", native: false });
    expect(() => server.emit({ kind: "event", type: "theme", theme: "neon", native: false } as never)).toThrow();
    expect(f.posted).toEqual([{ kind: "event", type: "theme", theme: "dark", native: false }]);
  });
});

describe("webview html", () => {
  const index = `<!doctype html><html><head><link rel="icon" href="data:x"><script type="module" crossorigin src="./assets/index-1.js"></script><link rel="stylesheet" href="./assets/index-2.css"></head><body><div id="root"></div></body></html>`;
  const html = buildWebviewHtml(index, { nonce: "N0NCE", cspSource: "https://res.example", resourceUri: (p) => `https://res.example/dist/webview/${p}` });

  it("rewrites relative assets to webview resource URIs and leaves data: URIs alone", () => {
    expect(html).toContain('src="https://res.example/dist/webview/assets/index-1.js"');
    expect(html).toContain('href="https://res.example/dist/webview/assets/index-2.css"');
    expect(html).toContain('href="data:x"');
    expect(html).not.toContain('"./');
  });

  it("adds the nonce to every script and a CSP without any remote or network source", () => {
    expect(html).toContain('<script nonce="N0NCE" type="module"');
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N0NCE' https://res.example");
    expect(csp).not.toMatch(/https?:\/\/(?!res\.example)|\*|'unsafe-eval'/);
  });
});

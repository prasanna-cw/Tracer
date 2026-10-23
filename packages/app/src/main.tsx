import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "@vscode/codicons/dist/codicon.css";
import "./themes/light.css";
import "./themes/dark.css";
import "./themes/native.css";
import "./app.css";
import { App } from "./App";
import type { HostAdapter, HostEnv } from "./host/HostAdapter";
import { inVsCode, VSCodeHost } from "./host/VSCodeHost";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");
const mount = (
  el: HTMLElement,
  createHost: (notify: (m: string) => void) => HostAdapter,
  env: HostEnv,
  theme?: "light" | "dark",
  native?: boolean,
) =>
  createRoot(el).render(
    <StrictMode>
      <App createHost={createHost} env={env} initialTheme={theme} initialNative={native} />
    </StrictMode>,
  );

async function boot(el: HTMLElement): Promise<void> {
  if (inVsCode()) {
    const host = new VSCodeHost();
    const init = await host.call("init", {});
    const env: HostEnv =
      init.mode === "editor" && init.documentId ? { kind: "editor", documentId: init.documentId } : { kind: "graph" };
    mount(el, () => host, env, init.theme, init.native);
    return;
  }
  // Compiled out of the webview build (`--mode webview`), along with the samples WebHost bundles.
  if (import.meta.env.MODE === "webview") throw new Error("this build only runs inside VS Code");
  const { WebHost } = await import("./host/WebHost");
  mount(el, (notify) => new WebHost(notify), { kind: "web" });
}

boot(root).catch((e: unknown) => {
  root.textContent = `CodeMap failed to start: ${e instanceof Error ? e.message : String(e)}`;
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode webview` builds the bundle the VS Code extension ships: relative asset paths, no public/ folder
// (it may hold a local graph.json analysis that must never end up in a .vsix), and no web-only host code.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  publicDir: mode === "webview" ? false : "public",
  build: { chunkSizeWarningLimit: 700 },
}));

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // samples/demo-repo contains test files that belong to the fixture, not to us.
  // samples/ fixtures carry their own test files; the extension e2e suite runs inside VS Code (npm run test:vscode).
  test: { exclude: [...configDefaults.exclude, "samples/**", "packages/extension/test/e2e/**", "**/.vscode-test/**"] },
});

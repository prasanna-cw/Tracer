import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // samples/demo-repo contains test files that belong to the fixture, not to us.
  test: { exclude: [...configDefaults.exclude, "samples/**"] },
});

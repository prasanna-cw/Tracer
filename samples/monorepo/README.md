# monorepo fixture

A tiny npm-workspaces monorepo for the analyzer's nearest-tsconfig test (`packages/cli/test/analyze.test.ts`).

`packages/web` and `packages/api` both map the **same alias** `~/*` to their **own** `src/`, via their own
`tsconfig.json` (which `extends` the shared `tsconfig.base.json`). A root-only resolver cannot get both right.
`@mono/shared` is reached through each package's `paths`; `scripts/` falls back to the root `tsconfig.json`.

Expected: 10 files, 8 edges, 0 unresolved, 0 external, packages `packages/api`, `packages/shared`, `packages/web`.

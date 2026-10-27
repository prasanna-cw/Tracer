# demo-repo

A small synthetic project that exists only to be analyzed. It is the permanent fixture for the
analyzer tests (`packages/cli/test/analyze.test.ts`) and for the committed `samples/demo-graph.json`.
It is never built or run, and our own lint/test/typecheck skip it.

What it exercises, and the exact numbers the tests expect:

| Feature | Where |
| --- | --- |
| `.ts .tsx .js .jsx .mjs .cjs` | all over `src/` |
| tsconfig `paths` aliases (`@core`, `@core/*`, `@ui`, `@utils`) | `main.ts`, `app.tsx`, `ui/Button.tsx`, `features/reports/index.ts` |
| barrel files | `core/index.ts`, `ui/index.ts`, `utils/index.js` |
| `require("...")` | `features/legacy/server.cjs` |
| dynamic `import("...")` | `app.tsx` |
| `.js` specifier resolving to a `.ts` file | `features/reports/chart.js` |
| 3-file circular import | `core/cycle/a.ts -> b.ts -> c.ts -> a.ts` |
| orphan | `orphan.ts` |
| tests | `ui/__tests__/Button.test.tsx`, `utils/numbers.test.ts` |
| unresolvable imports (3) | `broken/missing.ts` |
| syntax error (skipped with a warning) | `broken/syntax-error.ts` |

Expected: 26 files analyzed (1 skipped; this README counts too, as a doc node), 29 edges, 3 unresolved,
5 external, 1 cycle, 3 orphans (this README, `orphan.ts`, and `broken/missing.ts`, whose only imports are
unresolvable).

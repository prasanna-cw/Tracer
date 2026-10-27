# Changelog

## 0.0.6

- Map and Graph refresh automatically while they're open: edit and save, and the diagram updates in place, no need to reopen the view.
- Analysis is cached on disk, so opening Map/Graph again on a workspace you've already analyzed is instant instead of a full re-scan; only changed files are reparsed.
- Markdown docs (`.md`) now appear in the map and graph, linked to the code they reference: a relative link, or a code span naming one function or type declared in exactly one file.
- `docker-compose.yml` (and `compose.yml`, override files) are linked to the services they build; a `depends_on` between two local services becomes an edge in the graph.

## 0.0.5

- New Marketplace page: screenshots, feature tour, language table and privacy summary.
- More search keywords and categories.

## 0.0.4

- Show Flow no longer waits for the whole workspace to be read: the diagram appears at once, and calls into other files are linked as soon as the workspace is indexed (Trace Calls waits, with a cancel button).
- **Show Flow** with the cursor inside a function now draws that function; selecting a function's name or whole body does too.
- Functions without a name (Express routes, React hooks, test bodies, lambdas, Ruby blocks, PHP closures) now have flows.
- Cursor on a comment, decorator or `export`/`async` line above a function finds that function.
- React components and multi-line `return (` show what is returned; Python `elif`/`else` branches are all drawn; Trace Calls works in Python and Ruby.
- Lua and Zig work; Dart method bodies, C#/Kotlin/Swift accessors, initializers and destructors are found.
- Very large files (15,000 lines tested) open quickly; the file overview shows the first 60 functions.
- A warning appears when the code does not parse; a file outside the workspace no longer reads its whole folder; Python virtualenvs are skipped.
- The graph glides and fades smoothly, and its labels no longer overlap.

## 0.0.3

- Cursor on a modifier or decorator line (`export`, `async`, `@Get()`) finds the function; "no function" is now a visible warning.

## 0.0.1

- First release: Show Flow, Show Flow of This Function, Trace Calls, Map and Graph, for 19 languages.

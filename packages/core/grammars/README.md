# Vendored grammars

Grammars here replace the one of the same name from `tree-sitter-wasms`.

| File | Source | Why |
| --- | --- | --- |
| `tree-sitter-lua.wasm` | `@tree-sitter-grammars/tree-sitter-lua@0.4.1` (npm), MIT, see `LICENSE-tree-sitter-lua.md`; sha256 `6d95607fc7d78964cfdf065ccb1ba76be5ed217c5ec0d0a3cace13c59fa1ae43` | The `tree-sitter-wasms@0.1.13` Lua grammar parses correctly only once per process: every later parse returns ERROR trees. Only the `.wasm` is copied because the npm package runs a native install script. |

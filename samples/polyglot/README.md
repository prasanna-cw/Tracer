# polyglot fixture

Ten small services in ten languages, one workspace: the fixture for Tracer's multi-language analysis
(`packages/cli/test/analyze.test.ts`) and for flows of real-looking code (Spring-style Java, C#, Go…).
Never built or run.

| Service | Language | Linked by |
| --- | --- | --- |
| `orders-java` | Java (Maven) | imports + type names (Controller → Service → Repository → Model) |
| `billing-kotlin` | Kotlin (Gradle) | same-package type names, no imports |
| `users-python` | Python | absolute and relative imports |
| `inventory-go` | Go | module path to package directory |
| `payments-csharp` | C# | `using` namespaces + type names |
| `search-rust` | Rust | `mod`, `crate::`, `super::` |
| `legacy-php` | PHP | `use` names + `require_once __DIR__ …` |
| `notify-ruby` | Ruby | `require_relative` + constants |
| `engine-cpp` | C++ (CMake) | `#include` (relative and `include/`) |
| `web-ts` | TypeScript | relative imports |

Expected: 34 files (the `.h` headers and `build.gradle.kts` count), 23 edges, 0 unresolved, 10 services.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzePath, serializeGraph } from "../src/analyze";

const demoRoot = fileURLToPath(new URL("../../../samples/demo-repo", import.meta.url));
const r = await analyzePath(demoRoot);
const g = r.graph;
const edges = g.edges.map((e) => `${e.source} -> ${e.target}`);

describe("analyzer on samples/monorepo (nearest tsconfig per file)", () => {
  let m: Awaited<ReturnType<typeof analyzePath>>["graph"];
  beforeAll(async () => {
    m = (await analyzePath(fileURLToPath(new URL("../../../samples/monorepo", import.meta.url)))).graph;
  });

  it("resolves the same alias (~/*) against each package's own tsconfig", () => {
    expect(m.edges.map((e) => `${e.source} -> ${e.target}`)).toEqual([
      "packages/api/src/routes/index.ts -> packages/api/src/db.ts", // ~/db in api
      "packages/api/src/server.ts -> packages/api/src/routes/index.ts", // ~/routes in api
      "packages/api/src/server.ts -> packages/shared/src/index.ts", // @mono/shared via api's paths
      "packages/shared/src/index.ts -> packages/shared/src/greet.ts",
      "packages/web/src/components/Header.tsx -> packages/web/src/lib/format.ts", // ~/lib in web
      "packages/web/src/main.tsx -> packages/shared/src/index.ts",
      "packages/web/src/main.tsx -> packages/web/src/components/Header.tsx",
      "scripts/build.mjs -> scripts/util.mjs", // root tsconfig (allowJs)
    ]);
    expect(m.summary).toMatchObject({ fileCount: 10, edgeCount: 8, unresolvedCount: 0, externalCount: 0, warnings: [] });
  });

  it("lists the workspace packages", () => {
    expect(m.packages).toEqual(["packages/api", "packages/shared", "packages/web"]);
  });
});

describe("analyzer on samples/demo-repo", () => {
  it("summary has the exact expected counts", () => {
    expect(g.summary).toMatchObject({
      fileCount: 25,
      skippedCount: 1,
      edgeCount: 29,
      unresolvedCount: 3,
      externalCount: 5,
      assetCount: 0,
      cycleCount: 1,
    });
    expect(r.cycleEdges).toBe(3);
    expect(g.root).toBe("demo-repo"); // never an absolute path
  });

  it("finds exactly these edges (deduplicated, sorted)", () => {
    expect(edges).toEqual([
      "src/app.tsx -> src/core/store.ts", // @core/store alias
      "src/app.tsx -> src/features/reports/index.ts", // dynamic import()
      "src/app.tsx -> src/features/widgets/Widget.jsx",
      "src/app.tsx -> src/ui/index.ts", // @ui alias to a barrel
      "src/core/cycle/a.ts -> src/core/cycle/b.ts",
      "src/core/cycle/b.ts -> src/core/cycle/c.ts",
      "src/core/cycle/c.ts -> src/core/cycle/a.ts",
      "src/core/format.ts -> src/core/config.ts",
      "src/core/index.ts -> src/core/format.ts", // export { } from
      "src/core/index.ts -> src/core/store.ts", // export * from
      "src/core/store.ts -> src/core/format.ts",
      "src/features/legacy/bridge.mjs -> src/features/legacy/helper.cjs", // .mjs importing .cjs
      "src/features/legacy/server.cjs -> src/features/legacy/helper.cjs", // require()
      "src/features/reports/chart.js -> src/core/format.ts", // "./format.js" resolves to format.ts
      "src/features/reports/index.ts -> src/core/cycle/a.ts",
      "src/features/reports/index.ts -> src/core/index.ts", // @core alias
      "src/features/reports/index.ts -> src/features/reports/chart.js",
      "src/features/widgets/Widget.jsx -> src/ui/index.ts", // directory import -> index.ts
      "src/main.ts -> src/app.tsx",
      "src/main.ts -> src/features/legacy/bridge.mjs",
      "src/main.ts -> src/utils/index.js", // @utils alias to a .js barrel
      "src/ui/Button.tsx -> src/core/format.ts", // @core/* alias
      "src/ui/Card.jsx -> src/ui/Button.tsx",
      "src/ui/__tests__/Button.test.tsx -> src/ui/Button.tsx",
      "src/ui/index.ts -> src/ui/Button.tsx",
      "src/ui/index.ts -> src/ui/Card.jsx",
      "src/utils/index.js -> src/utils/numbers.js",
      "src/utils/index.js -> src/utils/strings.js",
      "src/utils/numbers.test.ts -> src/utils/numbers.js",
    ]);
  });

  it("lists the unresolvable imports and skips the broken file with a warning", () => {
    expect(g.summary.unresolved).toEqual([
      { from: "src/broken/missing.ts", specifier: "./does-not-exist" },
      { from: "src/broken/missing.ts", specifier: "@core/nope" },
      { from: "src/broken/missing.ts", specifier: "../features/ghost.js" },
    ]);
    expect(g.summary.warnings).toEqual(["src/broken/syntax-error.ts:3: syntax error (Expression expected.); skipped"]);
    expect(g.nodes.map((n) => n.path)).not.toContain("src/broken/syntax-error.ts");
  });

  it("fills node metadata (folder, ext, loc, degrees)", () => {
    const orphans = g.nodes.filter((n) => n.inDegree + n.outDegree === 0).map((n) => n.path);
    expect(orphans).toEqual(["src/broken/missing.ts", "src/orphan.ts"]);
    expect(g.nodes.find((n) => n.path === "src/core/format.ts")).toMatchObject({
      folder: "src/core",
      ext: "ts",
      loc: 3,
      inDegree: 4,
      outDegree: 1,
    });
    expect(new Set(g.nodes.map((n) => n.ext))).toEqual(new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]));
  });

  it("the committed samples/demo-graph.json is up to date (run `npm run analyze:demo` if this fails)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../../../samples/demo-graph.json", import.meta.url)), "utf8");
    expect(committed.replace(/\r\n/g, "\n")).toBe(serializeGraph(r));
  });
});

describe("analyzer on samples/polyglot (10 services, 10 languages)", () => {
  let p: Awaited<ReturnType<typeof analyzePath>>["graph"];
  beforeAll(async () => {
    p = (await analyzePath(fileURLToPath(new URL("../../../samples/polyglot", import.meta.url)))).graph;
  }, 60_000);

  it("links every language by its own rules", () => {
    const e = p.edges.map((x) => `${x.source} -> ${x.target}`);
    expect(e).toEqual([
      "billing-kotlin/src/main/kotlin/com/acme/billing/BillingService.kt -> billing-kotlin/src/main/kotlin/com/acme/billing/Invoice.kt", // same package, no import
      "engine-cpp/src/engine.cpp -> engine-cpp/include/util/log.h", // include/ directory
      "engine-cpp/src/engine.cpp -> engine-cpp/src/engine.h",
      "engine-cpp/src/main.cpp -> engine-cpp/src/engine.h",
      "inventory-go/main.go -> inventory-go/internal/store/memory.go", // a Go import is a whole package
      "inventory-go/main.go -> inventory-go/internal/store/store.go",
      "legacy-php/src/Controllers/HomeController.php -> legacy-php/src/Models/Page.php", // use App\Models\Page
      "legacy-php/src/Controllers/HomeController.php -> legacy-php/src/helpers.php", // require_once __DIR__ . '/../helpers.php'
      "notify-ruby/lib/notifier.rb -> notify-ruby/lib/channels/email.rb",
      "orders-java/src/main/java/com/acme/orders/repo/OrderRepository.java -> orders-java/src/main/java/com/acme/orders/model/Order.java",
      "orders-java/src/main/java/com/acme/orders/service/OrderService.java -> orders-java/src/main/java/com/acme/orders/model/Order.java",
      "orders-java/src/main/java/com/acme/orders/service/OrderService.java -> orders-java/src/main/java/com/acme/orders/repo/OrderRepository.java",
      "orders-java/src/main/java/com/acme/orders/web/OrderController.java -> orders-java/src/main/java/com/acme/orders/service/OrderService.java",
      "payments-csharp/Controllers/PaymentsController.cs -> payments-csharp/Services/IPaymentService.cs", // using namespace + type name
      "payments-csharp/Services/PaymentService.cs -> payments-csharp/Models/Payment.cs",
      "payments-csharp/Services/PaymentService.cs -> payments-csharp/Services/IPaymentService.cs", // same namespace
      "search-rust/src/main.rs -> search-rust/src/index.rs", // mod index;
      "search-rust/src/main.rs -> search-rust/src/query/mod.rs", // mod query; + use crate::query::Query
      "search-rust/src/query/mod.rs -> search-rust/src/index.rs", // use super::index::Index
      "users-python/app/main.py -> users-python/app/routes/users.py", // from app.routes import users
      "users-python/app/routes/users.py -> users-python/app/db.py", // from ..db import session
      "users-python/app/routes/users.py -> users-python/app/models.py",
      "web-ts/src/main.ts -> web-ts/src/api.ts",
    ]);
    expect(p.summary).toMatchObject({ fileCount: 34, unresolvedCount: 0, skippedCount: 0 });
  });

  it("detects the ten services with their build systems, and tags files with language and service", () => {
    expect(p.services?.map((s) => `${s.path}:${s.kind}`)).toEqual([
      "billing-kotlin:gradle", "engine-cpp:cmake", "inventory-go:go", "legacy-php:composer", "notify-ruby:ruby",
      "orders-java:maven", "payments-csharp:dotnet", "search-rust:cargo", "users-python:python", "web-ts:npm",
    ]);
    expect(p.nodes.find((n) => n.path.endsWith("OrderService.java"))).toMatchObject({ lang: "java", service: "orders-java" });
    expect(Object.keys(p.summary.languages ?? {}).sort()).toEqual(["c", "cpp", "csharp", "go", "java", "kotlin", "php", "python", "ruby", "rust", "typescript"]);
  });
});

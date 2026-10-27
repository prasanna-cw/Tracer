import { describe, expect, it } from "vitest";
import { parseCompose, parseIndentedTree } from "../src/analyzer/composeLinks";

describe("parseIndentedTree", () => {
  it("nests mapping keys by indent, and a list item like one extra mapping level", () => {
    const tree = parseIndentedTree(["a:", "  b: 1", "  c:", "    - x", "    - y"].join("\n"));
    expect(tree).toEqual([
      { key: "a", value: "", indent: 0, children: [
        { key: "b", value: "1", indent: 2, children: [] },
        { key: "c", value: "", indent: 2, children: [
          { key: "x", value: "", indent: 4, children: [] },
          { key: "y", value: "", indent: 4, children: [] },
        ] },
      ] },
    ]);
  });

  it("ignores blank lines, comments, and a document separator", () => {
    const tree = parseIndentedTree(["---", "# a comment", "", "a: 1", "", "# trailing"].join("\n"));
    expect(tree).toEqual([{ key: "a", value: "1", indent: 0, children: [] }]);
  });

  it("strips quotes from a value and treats a tab as two spaces of indent", () => {
    const tree = parseIndentedTree('a: "b"\n\tc: 1\n');
    expect(tree[0]).toMatchObject({ key: "a", value: "b" });
    expect(tree[0]?.children[0]).toMatchObject({ key: "c", indent: 2 }); // one tab, nested under "a"
  });

  it("a list item with a key:value pair becomes a child node named by that key", () => {
    const tree = parseIndentedTree(["deps:", "  - name: a", "  - name: b"].join("\n"));
    expect(tree[0]?.children).toEqual([
      { key: "name", value: "a", indent: 2, children: [] },
      { key: "name", value: "b", indent: 2, children: [] },
    ]);
  });
});

describe("parseCompose", () => {
  it("reads a bare build path, and depends_on as a list", () => {
    const text = ["services:", "  orders:", "    build: ./orders", "    depends_on:", "      - billing", "      - redis"].join("\n");
    expect(parseCompose(text)).toEqual([{ name: "orders", context: "./orders", dependsOn: ["billing", "redis"] }]);
  });

  it("reads build as a map with a context key", () => {
    const text = ["services:", "  orders:", "    build:", "      context: ./orders", "      dockerfile: Dockerfile.dev"].join("\n");
    expect(parseCompose(text)).toEqual([{ name: "orders", context: "./orders", dependsOn: [] }]);
  });

  it("reads depends_on as a map (the condition per dependency is ignored)", () => {
    const text = ["services:", "  orders:", "    build: ./orders", "    depends_on:", "      billing:", "        condition: service_healthy", "      redis: {}"].join("\n");
    expect(parseCompose(text)).toEqual([{ name: "orders", context: "./orders", dependsOn: ["billing", "redis"] }]);
  });

  it("reads the inline-list form of depends_on", () => {
    const text = ["services:", "  orders:", "    build: ./orders", "    depends_on: [billing, redis]"].join("\n");
    expect(parseCompose(text)).toEqual([{ name: "orders", context: "./orders", dependsOn: ["billing", "redis"] }]);
  });

  it("an image-only service has no build context", () => {
    const text = ["services:", "  db:", "    image: postgres:16"].join("\n");
    expect(parseCompose(text)).toEqual([{ name: "db", context: undefined, dependsOn: [] }]);
  });

  it("a file with no services block returns nothing", () => {
    expect(parseCompose("version: '3'\n")).toEqual([]);
  });
});

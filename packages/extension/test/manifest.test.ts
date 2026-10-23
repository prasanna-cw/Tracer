import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "@tracer/core/engine";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  contributes: {
    commands: { command: string }[];
    menus: Record<string, { command?: string; submenu?: string; when?: string }[]>;
    submenus: { id: string }[];
  };
  activationEvents: string[];
};
const { commands, menus, submenus } = manifest.contributes;

describe("extension manifest", () => {
  it("the right-click menu appears for every language Tracer reads, and no others", () => {
    const when = menus["editor/context"]?.[0]?.when ?? "";
    const re = new RegExp(/resourceExtname =~ \/(.*)\//.exec(when)?.[1] ?? "(?!)");
    for (const ext of LANGUAGES.flatMap((l) => l.extensions)) expect(re.test(ext), ext).toBe(true);
    for (const ext of [".md", ".json", ".txt", ".html", ".canvas"]) expect(re.test(ext), ext).toBe(false);
  });

  it("every command used in a menu is declared, and the submenu exists", () => {
    const declared = new Set(commands.map((c) => c.command));
    for (const entries of Object.values(menus)) for (const m of entries) if (m.command) expect(declared.has(m.command), m.command).toBe(true);
    expect(menus["editor/context"]?.[0]?.submenu).toBe("tracer.editorMenu");
    expect(submenus.map((s) => s.id)).toContain("tracer.editorMenu");
    expect(menus["tracer.editorMenu"]?.map((m) => m.command)).toEqual(["tracer.showFlow", "tracer.showFunctionFlow", "tracer.traceCalls"]);
  });

  it("Show Flow is also in the explorer menu for files, and Open Graph for folders", () => {
    const explorer = menus["explorer/context"] ?? [];
    expect(explorer.find((m) => m.command === "tracer.showFlow")?.when).toContain("!explorerResourceIsFolder");
    expect(explorer.find((m) => m.command === "tracer.openGraph")?.when).toBe("explorerResourceIsFolder");
    expect(explorer.find((m) => m.command === "tracer.openMap")?.when).toBe("explorerResourceIsFolder");
  });
});

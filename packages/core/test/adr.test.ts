import { describe, expect, it } from "vitest";
import { adrFilename, adrTemplate, nextAdrNumber, parseAdr, slugify } from "../src/graph/adr";

describe("parseAdr", () => {
  it("reads a numbered heading and the status/date fields", () => {
    const text = adrTemplate(3, "Use a message queue", "2026-01-15");
    expect(parseAdr(text)).toEqual({ number: 3, title: "Use a message queue", status: "Proposed", date: "2026-01-15" });
  });

  it("reads a heading with no number, and tolerates a missing field", () => {
    expect(parseAdr("# Pick a database\n\nStatus: Accepted\n\n## Context\n")).toEqual({
      number: undefined,
      title: "Pick a database",
      status: "Accepted",
      date: undefined,
    });
  });

  it("stops reading fields once the body starts, even if the body mentions 'Status:' in prose", () => {
    const text = "# Title\n\nStatus: Accepted\n\n## Context\n\nStatus: this is just prose, not a field.\n";
    expect(parseAdr(text)?.status).toBe("Accepted");
  });

  it("returns undefined for a file with no ADR-shaped heading", () => {
    expect(parseAdr("Just some notes, no heading.\n")).toBeUndefined();
  });
});

describe("slugify", () => {
  it("lowercases, replaces runs of non-alphanumerics with one hyphen, and trims hyphens at the ends", () => {
    expect(slugify("Use a message queue!")).toBe("use-a-message-queue");
    expect(slugify("  Leading/trailing punctuation?! ")).toBe("leading-trailing-punctuation");
  });
});

describe("nextAdrNumber", () => {
  it("is one past the highest existing NNNN- prefix", () => {
    expect(nextAdrNumber(["0001-a.md", "0003-b.md", "0002-c.md"])).toBe(4);
  });
  it("is 1 when there are no numbered files yet", () => {
    expect(nextAdrNumber([])).toBe(1);
    expect(nextAdrNumber(["readme.md", "notes.md"])).toBe(1);
  });
});

describe("adrFilename", () => {
  it("zero-pads the number and slugifies the title", () => {
    expect(adrFilename(7, "Use a message queue")).toBe("0007-use-a-message-queue.md");
  });
});

describe("adrTemplate", () => {
  it("round-trips through parseAdr", () => {
    const text = adrTemplate(12, "Switch to trunk-based development", "2026-03-01");
    expect(parseAdr(text)).toEqual({ number: 12, title: "Switch to trunk-based development", status: "Proposed", date: "2026-03-01" });
  });
});

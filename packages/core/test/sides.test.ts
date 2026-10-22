import { describe, expect, it } from "vitest";
import { chooseSides } from "../src";

const box = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });

describe("chooseSides", () => {
  it("stacked vertically: bottom -> top, and the reverse", () => {
    expect(chooseSides(box(0, 0), box(30, 200))).toEqual({ fromSide: "bottom", toSide: "top" });
    expect(chooseSides(box(30, 200), box(0, 0))).toEqual({ fromSide: "top", toSide: "bottom" });
  });

  it("side by side: right -> left, and the reverse", () => {
    expect(chooseSides(box(0, 0), box(300, 20))).toEqual({ fromSide: "right", toSide: "left" });
    expect(chooseSides(box(300, 20), box(0, 0))).toEqual({ fromSide: "left", toSide: "right" });
  });

  it("vertical overlap wins over a larger vertical gap (wide target below)", () => {
    // Narrow box above a very wide one: x-ranges overlap, so connect vertically.
    expect(chooseSides(box(900, 0, 50, 50), box(0, 100, 1000, 50))).toEqual({ fromSide: "bottom", toSide: "top" });
  });

  it("diagonal: follows the larger center distance", () => {
    expect(chooseSides(box(0, 0), box(400, 150))).toEqual({ fromSide: "right", toSide: "left" });
    expect(chooseSides(box(0, 0), box(150, 400))).toEqual({ fromSide: "bottom", toSide: "top" });
  });

  it("keeps explicit sides and fills only the missing one", () => {
    expect(chooseSides(box(0, 0), box(300, 0), { toSide: "top" })).toEqual({ fromSide: "right", toSide: "top" });
    expect(chooseSides(box(0, 0), box(0, 300), { fromSide: "left", toSide: "left" })).toEqual({
      fromSide: "left",
      toSide: "left",
    });
  });

  it("overlapping boxes do not throw and pick a deterministic side", () => {
    expect(chooseSides(box(0, 0), box(10, 10))).toEqual({ fromSide: "bottom", toSide: "top" });
    expect(chooseSides(box(0, 0), box(0, 0))).toEqual({ fromSide: "bottom", toSide: "top" });
  });
});

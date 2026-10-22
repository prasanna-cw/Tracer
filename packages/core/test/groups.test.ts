import { describe, expect, it } from "vitest";
import { groupMembers, moveGroup, type DiagramNode } from "../src";

const n = (id: string, x: number, y: number, w: number, h: number, type: DiagramNode["type"] = "text"): DiagramNode => ({
  id,
  type,
  x,
  y,
  width: w,
  height: h,
});

const nodes = [
  n("outer", 0, 0, 500, 400, "group"),
  n("inner", 20, 40, 200, 200, "group"),
  n("a", 30, 60, 50, 50), // inside inner (and outer)
  n("b", 300, 60, 50, 50), // inside outer only
  n("edge", 480, 60, 50, 50), // straddles outer's right border: not a member
  n("away", 900, 900, 50, 50),
];

describe("groupMembers", () => {
  it("returns fully contained nodes, including nested groups and their contents", () => {
    expect(groupMembers(nodes, "outer").map((x) => x.id)).toEqual(["inner", "a", "b"]);
    expect(groupMembers(nodes, "inner").map((x) => x.id)).toEqual(["a"]);
  });

  it("is empty for an empty group, a non-group, or a missing id", () => {
    expect(groupMembers([n("g", 0, 0, 10, 10, "group")], "g")).toEqual([]);
    expect(groupMembers(nodes, "a")).toEqual([]);
    expect(groupMembers(nodes, "nope")).toEqual([]);
  });
});

describe("moveGroup", () => {
  it("shifts the group and its members by the same delta", () => {
    expect(moveGroup(nodes, "inner", 120, 140)).toEqual([
      { id: "inner", x: 120, y: 140 },
      { id: "a", x: 130, y: 160 },
    ]);
  });
});

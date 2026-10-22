import { expect, it } from "vitest";
import { add } from "./numbers.js";

it("adds", () => expect(add(1, 2)).toBe(3));

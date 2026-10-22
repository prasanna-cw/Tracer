import { describe, expect, it } from "vitest";
import { createLayout, type FromLayout, type LayoutSettings } from "../src/graph/layoutEngine";

const settings: LayoutSettings = { center: 0.06, repel: 140, linkStrength: 0.5, linkDistance: 50 };
const nodes = [
  { id: "a", r: 4 },
  { id: "b", r: 4 },
  { id: "c", r: 4, x: 500, y: 500 },
];
const links: [number, number][] = [
  [0, 1],
  [1, 2],
];

/** Runs scheduled work by hand, with a fake clock (5 ms per read): frame counts don't depend on machine speed. */
function harness() {
  const posts: FromLayout[] = [];
  const queue: (() => void)[] = [];
  let clock = 0;
  const layout = createLayout(
    (m) => posts.push(m),
    (fn) => queue.push(fn),
    () => (clock += 5),
  );
  const drain = (max = 10_000) => {
    for (let i = 0; i < max && queue.length; i++) queue.shift()?.();
  };
  return { layout, posts, queue, drain };
}

describe("layout engine (worker side)", () => {
  it("animates: posts frames until the layout settles, then stops scheduling", () => {
    const h = harness();
    h.layout.handle({ type: "graph", gen: 1, nodes, links, settings, reduceMotion: false });
    h.drain();
    expect(h.posts.length).toBeGreaterThan(1);
    expect(h.posts.at(-1)?.settled).toBe(true);
    expect(h.posts.slice(0, -1).every((p) => !p.settled)).toBe(true);
    expect(h.queue).toHaveLength(0);
    expect(h.posts.at(-1)?.positions).toHaveLength(6);
  });

  it("keeps given positions as the starting point (filters don't reshuffle the layout)", () => {
    const h = harness();
    h.layout.handle({ type: "graph", gen: 1, nodes, links: [], settings: { ...settings, center: 0, repel: 0 }, reduceMotion: true });
    const [x, y] = [h.posts[0]!.positions[4], h.posts[0]!.positions[5]];
    expect(x).toBeCloseTo(500, 0);
    expect(y).toBeCloseTo(500, 0);
  });

  it("reduced motion: settles synchronously and posts exactly one frame", () => {
    const h = harness();
    h.layout.handle({ type: "graph", gen: 1, nodes, links, settings, reduceMotion: true });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.settled).toBe(true);
    expect(h.queue).toHaveLength(0);
  });

  it("pins a dragged node, keeps running while dragging, and releases on drop", () => {
    const h = harness();
    h.layout.handle({ type: "graph", gen: 1, nodes, links, settings, reduceMotion: true });
    h.layout.handle({ type: "drag", index: 0, x: -300, y: 200 });
    for (let i = 0; i < 50; i++) h.queue.shift()?.();
    const last = h.posts.at(-1)!;
    expect([last.positions[0], last.positions[1]]).toEqual([-300, 200]);
    expect(last.settled).toBe(false); // never settles mid-drag
    h.layout.handle({ type: "release", index: 0 });
    h.drain();
    expect(h.posts.at(-1)!.settled).toBe(true);
    expect(h.posts.at(-1)!.positions[0]).not.toBe(-300); // free again
  });

  it("ignores drag/release for unknown indices", () => {
    const h = harness();
    h.layout.handle({ type: "drag", index: 99, x: 0, y: 0 });
    h.layout.handle({ type: "release", index: 99 });
    expect(h.posts).toEqual([]);
  });
});

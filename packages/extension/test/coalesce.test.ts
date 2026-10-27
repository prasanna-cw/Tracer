import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coalesced } from "../src/coalesce";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Coalesced", () => {
  it("runs once after the delay, however many times it was triggered", async () => {
    let runs = 0;
    const c = new Coalesced(100, async () => void runs++);
    c.trigger();
    c.trigger();
    c.trigger();
    await vi.advanceTimersByTimeAsync(99);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
  });

  it("a trigger during a run is not dropped: it schedules exactly one more run after", async () => {
    let runs = 0;
    let resolveFirst!: () => void;
    const c = new Coalesced(10, async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => (resolveFirst = r));
    });
    c.trigger();
    await vi.advanceTimersByTimeAsync(10); // the first run starts and blocks on resolveFirst
    expect(runs).toBe(1);

    c.trigger(); // arrives while the first run is still in flight
    c.trigger(); // a second trigger during the same run still means only one extra run
    await vi.advanceTimersByTimeAsync(10); // a mid-run trigger does not start its own timer
    expect(runs).toBe(1); // not run yet: still waiting on the first run to finish

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0); // lets the first run's `finally` settle and schedule the pending retrigger
    expect(runs).toBe(1); // the retrigger's own timer has not fired yet
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toBe(2); // and only once, not once per trigger that arrived mid-run
  });

  it("dispose cancels a pending run that never fired", async () => {
    let runs = 0;
    const c = new Coalesced(50, async () => void runs++);
    c.trigger();
    c.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(0);
  });
});

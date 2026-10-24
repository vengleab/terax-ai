import { describe, expect, it } from "vitest";
import { FlowControl } from "./flow";

function setup(high = 100, low = 40) {
  const calls: string[] = [];
  const flow = new FlowControl({ pause: (id) => calls.push(`pause ${id}`), resume: (id) => calls.push(`resume ${id}`) }, high, low);
  return { flow, calls };
}

describe("FlowControl", () => {
  it("pauses only once the unacknowledged output passes the high-water mark", () => {
    const { flow, calls } = setup();
    flow.sent(1, 100);
    expect(calls).toEqual([]);
    flow.sent(1, 1);
    expect(calls).toEqual(["pause 1"]);
    flow.sent(1, 500);
    expect(calls).toEqual(["pause 1"]);
  });

  it("resumes when the page has caught up to the low-water mark, not before", () => {
    const { flow, calls } = setup();
    flow.sent(1, 150);
    flow.acknowledged(1, 50);
    expect(calls).toEqual(["pause 1"]);
    flow.acknowledged(1, 61);
    expect(calls).toEqual(["pause 1", "resume 1"]);
    flow.acknowledged(1, 100);
    expect(calls).toEqual(["pause 1", "resume 1"]);
  });

  it("tracks sessions separately", () => {
    const { flow, calls } = setup();
    flow.sent(1, 150);
    flow.sent(2, 10);
    expect(calls).toEqual(["pause 1"]);
    expect(flow.isPaused(1)).toBe(true);
    expect(flow.isPaused(2)).toBe(false);
  });

  it("forgets a session that ended, so a late acknowledgement does nothing", () => {
    const { flow, calls } = setup();
    flow.sent(1, 150);
    flow.forget(1);
    flow.acknowledged(1, 150);
    expect(calls).toEqual(["pause 1"]);
    expect(flow.isPaused(1)).toBe(false);
  });

  it("never goes below zero when acknowledgements overshoot", () => {
    const { flow, calls } = setup();
    flow.acknowledged(1, 10);
    flow.sent(1, 5);
    flow.acknowledged(1, 100);
    flow.sent(1, 101);
    expect(calls).toEqual(["pause 1"]);
  });
});

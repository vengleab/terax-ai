import { describe, expect, it } from "vitest";
import type { TransferRequest, TransferSummary, WireEvent } from "../types";
import {
  applyWireEvent,
  clearConflict,
  describeOutcome,
  etaSeconds,
  isActive,
  newJob,
  percent,
  summarizeQueue,
} from "./queueStats";

const request: TransferRequest = {
  src: { kind: "local" },
  dst: { kind: "remote", profileId: "p" },
  sources: ["/a"],
  dstDir: "/d",
};

const job = () => newJob("k1", request, { title: "1 item", from: "Local", to: "prod" }, 1000);

const summary = (over: Partial<TransferSummary> = {}): TransferSummary => ({
  filesDone: 0,
  bytesDone: 0,
  filesSkipped: 0,
  moved: 0,
  errors: [],
  skipped: [],
  cancelled: false,
  ...over,
});

const progress = (over: Partial<Extract<WireEvent, { kind: "progress" }>> = {}): WireEvent => ({
  kind: "progress",
  bytesDone: 50,
  bytesTotal: 100,
  filesDone: 1,
  filesTotal: 2,
  bytesPerSec: 10,
  current: ["a.txt"],
  ...over,
});

describe("applyWireEvent", () => {
  it("moves from starting to running when planned, then tracks progress", () => {
    let j = applyWireEvent(job(), { kind: "planned", files: 2, bytes: 100, skipped: [] }, 1);
    expect(j.status).toBe("running");
    expect(j.bytes.total).toBe(100);
    j = applyWireEvent(j, progress(), 2);
    expect(j.bytes.done).toBe(50);
    expect(j.speed).toBe(10);
    expect(j.current).toEqual(["a.txt"]);
    expect(percent(j)).toBe(50);
    expect(etaSeconds(j)).toBe(5);
  });

  it("waits on a conflict and resumes after it is answered", () => {
    const info = { srcPath: "/s", dstPath: "/d", srcSize: 1, dstSize: 2, srcMtime: null, dstMtime: null };
    let j = applyWireEvent(job(), { kind: "conflict", conflictId: 4, info }, 1);
    expect(j.status).toBe("waiting");
    expect(j.conflict?.conflictId).toBe(4);
    j = applyWireEvent(j, progress(), 2);
    expect(j.status).toBe("waiting");
    j = clearConflict(j);
    expect(j.status).toBe("running");
    expect(j.conflict).toBeNull();
    expect(clearConflict(j)).toBe(j);
  });

  it("finishes as done, cancelled or error", () => {
    const done = applyWireEvent(job(), { kind: "finished", summary: summary({ filesDone: 2, bytesDone: 10 }) }, 9);
    expect(done.status).toBe("done");
    expect(done.finishedAt).toBe(9);
    expect(percent(done)).toBe(100);

    const cancelled = applyWireEvent(job(), { kind: "finished", summary: summary({ cancelled: true }) }, 9);
    expect(cancelled.status).toBe("cancelled");

    const failed = applyWireEvent(
      job(),
      { kind: "finished", summary: summary({ errors: [{ path: "/a", message: "denied" }] }) },
      9,
    );
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("denied");

    const partial = applyWireEvent(
      job(),
      { kind: "finished", summary: summary({ filesDone: 1, errors: [{ path: "/a", message: "denied" }] }) },
      9,
    );
    expect(partial.status).toBe("done");

    const hard = applyWireEvent(job(), { kind: "failed", error: { code: "io", message: "boom" } }, 9);
    expect(hard.status).toBe("error");
    expect(hard.error).toBe("boom");
  });

  it("ignores events after the job ended", () => {
    const ended = applyWireEvent(job(), { kind: "finished", summary: summary({ filesDone: 1 }) }, 9);
    expect(applyWireEvent(ended, progress(), 10)).toBe(ended);
    expect(isActive(ended)).toBe(false);
  });
});

describe("percent and eta", () => {
  it("falls back to file counts when sizes are unknown and clamps", () => {
    let j = applyWireEvent(job(), { kind: "planned", files: 4, bytes: 0, skipped: [] }, 1);
    j = applyWireEvent(j, progress({ bytesDone: 0, bytesTotal: 0, filesDone: 1, filesTotal: 4 }), 2);
    expect(percent(j)).toBe(25);
    j = applyWireEvent(j, progress({ bytesDone: 500, bytesTotal: 100 }), 3);
    expect(percent(j)).toBe(100);
    expect(percent(job())).toBe(0);
  });

  it("has no estimate without a speed", () => {
    const j = applyWireEvent(job(), progress({ bytesPerSec: 0 }), 2);
    expect(etaSeconds(j)).toBeNull();
  });
});

describe("describeOutcome", () => {
  it("summarizes what happened", () => {
    const done = applyWireEvent(
      job(),
      {
        kind: "finished",
        summary: summary({
          filesDone: 3,
          bytesDone: 2048,
          filesSkipped: 1,
          skipped: [{ path: "/l", reason: "link" }],
          errors: [{ path: "/e", message: "x" }],
        }),
      },
      1,
    );
    expect(describeOutcome(done)).toBe("3 files (2.00 KB), 1 skipped, 1 not copied, 1 error");
    const single = applyWireEvent(job(), { kind: "finished", summary: summary({ filesDone: 1, bytesDone: 5 }) }, 1);
    expect(describeOutcome(single)).toBe("1 file (5 B)");
    const empty = applyWireEvent(job(), { kind: "finished", summary: summary() }, 1);
    expect(describeOutcome(empty)).toBe("Nothing to do");
    const moved = applyWireEvent(job(), { kind: "finished", summary: summary({ moved: 2 }) }, 1);
    expect(describeOutcome(moved)).toBe("2 moved");
  });
});

describe("summarizeQueue", () => {
  it("adds up only the active jobs", () => {
    const a = applyWireEvent(job(), { kind: "planned", files: 1, bytes: 100, skipped: [] }, 1);
    const running = applyWireEvent(a, progress({ bytesDone: 40, bytesTotal: 100, bytesPerSec: 8 }), 2);
    const done = applyWireEvent(job(), { kind: "finished", summary: summary({ filesDone: 1 }) }, 3);
    expect(summarizeQueue([running, done])).toEqual({ active: 1, bytesDone: 40, bytesTotal: 100, speed: 8 });
    expect(summarizeQueue([])).toEqual({ active: 0, bytesDone: 0, bytesTotal: 0, speed: 0 });
  });
});

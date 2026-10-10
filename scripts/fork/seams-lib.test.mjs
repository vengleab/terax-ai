import { describe, expect, it } from "vitest";

import {
  countMarker,
  evaluateBudgets,
  evaluateSeams,
  isOwnedPath,
  parseSizeKb,
} from "./seams-lib.mjs";

const config = {
  marker: "fork:ssh-transfer",
  ownedPrefixes: ["FORK.md", "src/modules/ssh-transfer/"],
  seams: [{ file: "src/app/App.tsx", min: 2 }],
};

describe("countMarker", () => {
  it("counts every occurrence", () => {
    expect(countMarker("a fork:ssh-transfer b fork:ssh-transfer")).toBe(2);
    expect(countMarker("nothing here")).toBe(0);
    expect(countMarker("")).toBe(0);
  });
});

describe("isOwnedPath", () => {
  it("matches directory prefixes and exact files", () => {
    expect(isOwnedPath("src/modules/ssh-transfer/a.ts", config.ownedPrefixes)).toBe(true);
    expect(isOwnedPath("FORK.md", config.ownedPrefixes)).toBe(true);
    expect(isOwnedPath("FORK.md.bak", config.ownedPrefixes)).toBe(false);
    expect(isOwnedPath("src/modules/ssh-transfer-x/a.ts", config.ownedPrefixes)).toBe(false);
  });
});

describe("evaluateSeams", () => {
  it("passes when every seam is present", () => {
    const files = new Map([
      ["src/app/App.tsx", "// fork:ssh-transfer\n// fork:ssh-transfer\n"],
    ]);
    expect(evaluateSeams(config, files)).toEqual([]);
  });

  it("reports a seam dropped by a merge", () => {
    const files = new Map([["src/app/App.tsx", "// fork:ssh-transfer\n"]]);
    const errors = evaluateSeams(config, files);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("expected at least 2");
  });

  it("reports a missing seam file", () => {
    expect(evaluateSeams(config, new Map())[0]).toContain("missing");
  });

  it("reports markers in files that are not registered", () => {
    const files = new Map([
      ["src/app/App.tsx", "fork:ssh-transfer fork:ssh-transfer"],
      ["src/other.ts", "fork:ssh-transfer"],
      ["src/modules/ssh-transfer/x.ts", "fork:ssh-transfer"],
    ]);
    const errors = evaluateSeams(config, files);
    expect(errors).toEqual([
      expect.stringContaining("src/other.ts: unregistered"),
    ]);
  });

  it("enforces an optional upper bound", () => {
    const capped = {
      ...config,
      seams: [{ file: "a.ts", min: 1, max: 1 }],
    };
    const files = new Map([["a.ts", "fork:ssh-transfer fork:ssh-transfer"]]);
    expect(evaluateSeams(capped, files)[0]).toContain("at most 1");
  });
});

describe("parseSizeKb", () => {
  it("reads KB and MB values", () => {
    expect(parseSizeKb("1560 KB")).toBe(1560);
    expect(parseSizeKb("1.5 MB")).toBe(1536);
    expect(parseSizeKb("nonsense")).toBeUndefined();
  });
});

describe("evaluateBudgets", () => {
  const budgeted = {
    budgets: [{ file: ".size-limit.json", name: "total", minKb: 1560 }],
  };
  const sizeFile = (limit) =>
    new Map([[".size-limit.json", JSON.stringify([{ name: "total", limit }])]]);

  it("passes when the limit is at or above the fork minimum", () => {
    expect(evaluateBudgets(budgeted, sizeFile("1560 KB"))).toEqual([]);
    expect(evaluateBudgets(budgeted, sizeFile("2 MB"))).toEqual([]);
  });

  it("reports a limit reverted by an upstream merge", () => {
    expect(evaluateBudgets(budgeted, sizeFile("1505 KB"))[0]).toContain(
      "needs at least 1560 KB",
    );
  });

  it("reports a missing file or entry", () => {
    expect(evaluateBudgets(budgeted, new Map())[0]).toContain("missing");
    const renamed = new Map([[".size-limit.json", "[]"]]);
    expect(evaluateBudgets(budgeted, renamed)[0]).toContain('no entry named "total"');
  });

  it("does nothing without budgets", () => {
    expect(evaluateBudgets({}, new Map())).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatMode,
  formatSpeed,
  modeToOctal,
  parseOctalMode,
} from "./format";

describe("formatBytes", () => {
  it("scales units and keeps sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(1536)).toBe("1.50 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.00 TB");
  });

  it("is safe for bad input", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatSpeed / formatDuration", () => {
  it("hides a zero speed", () => {
    expect(formatSpeed(0)).toBe("");
    expect(formatSpeed(2048)).toBe("2.00 KB/s");
  });

  it("formats durations compactly", () => {
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3720)).toBe("1h 2m");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("modes", () => {
  it("renders rwx triples", () => {
    expect(formatMode(0o755)).toBe("rwxr-xr-x");
    expect(formatMode(0o640)).toBe("rw-r-----");
    expect(formatMode(0o100644)).toBe("rw-r--r--");
    expect(formatMode(null)).toBe("");
  });

  it("round trips octal text", () => {
    expect(modeToOctal(0o644)).toBe("644");
    expect(modeToOctal(0o4755)).toBe("4755");
    expect(modeToOctal(0o7)).toBe("007");
    expect(parseOctalMode("755")).toBe(0o755);
    expect(parseOctalMode(" 0644 ")).toBe(0o644);
  });

  it("rejects non octal text", () => {
    for (const bad of ["", "89", "12", "75555", "rwx", "7 5 5"]) {
      expect(parseOctalMode(bad), bad).toBeNull();
    }
  });
});

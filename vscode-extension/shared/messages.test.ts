import { describe, expect, it } from "vitest";
import { isOpenableLink, toBytes } from "./messages";

describe("isOpenableLink", () => {
  it("allows web and mail links", () => {
    expect(isOpenableLink("https://example.com/a?b=1")).toBe(true);
    expect(isOpenableLink("http://localhost:3000")).toBe(true);
    expect(isOpenableLink("mailto:someone@example.com")).toBe(true);
  });

  it("refuses everything that could run something or reach local files", () => {
    for (const uri of [
      "command:workbench.action.reloadWindow",
      "file:///etc/passwd",
      "vscode://vscode.git/clone?url=x",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "not a url",
      "",
    ]) {
      expect(isOpenableLink(uri), uri).toBe(false);
    }
  });
});

describe("toBytes", () => {
  it("accepts the shapes a message can arrive in", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(toBytes(bytes)).toBe(bytes);
    expect([...toBytes(bytes.buffer)]).toEqual([1, 2, 3]);
    expect([...toBytes(new DataView(bytes.buffer))]).toEqual([1, 2, 3]);
    expect([...toBytes([4, 5])]).toEqual([4, 5]);
    expect([...toBytes({ type: "Buffer", data: [6, 7] })]).toEqual([6, 7]);
  });

  it("keeps the window of a view into a larger buffer", () => {
    const big = Uint8Array.from([0, 1, 2, 3, 4]);
    expect([...toBytes(new Uint16Array(big.buffer, 2, 1))]).toEqual([2, 3]);
  });

  it("turns anything else into nothing rather than throwing", () => {
    expect(toBytes(undefined).length).toBe(0);
    expect(toBytes("text").length).toBe(0);
    expect(toBytes({}).length).toBe(0);
  });
});

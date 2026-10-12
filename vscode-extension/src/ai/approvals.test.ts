import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../shared/chat";
import { ApprovalBroker } from "./approvals";

const request = (id: string): ApprovalRequest => ({ id, kind: "command", title: "Run a command", detail: "ls" });

function setup() {
  const shown: string[] = [];
  const settled: string[] = [];
  const broker = new ApprovalBroker(
    (r) => shown.push(r.id),
    (id, ok) => settled.push(`${id}:${ok}`),
  );
  return { broker, shown, settled };
}

describe("ApprovalBroker", () => {
  it("shows the question and waits for the answer", async () => {
    const { broker, shown, settled } = setup();
    let result: boolean | undefined;
    const pending = broker.request(request("a")).then((v) => (result = v));
    expect(shown).toEqual(["a"]);
    await Promise.resolve();
    expect(result).toBeUndefined();
    expect(broker.answer("a", true)).toBe(true);
    await pending;
    expect(result).toBe(true);
    expect(settled).toEqual(["a:true"]);
  });

  it("tells apart several questions at once", async () => {
    const { broker } = setup();
    const a = broker.request(request("a"));
    const b = broker.request(request("b"));
    broker.answer("b", false);
    broker.answer("a", true);
    expect(await a).toBe(true);
    expect(await b).toBe(false);
  });

  it("ignores an answer for something that is not waiting, and a repeated one", async () => {
    const { broker } = setup();
    expect(broker.answer("nope", true)).toBe(false);
    const p = broker.request(request("a"));
    expect(broker.answer("a", false)).toBe(true);
    expect(broker.answer("a", true)).toBe(false);
    expect(await p).toBe(false);
  });

  it("counts everything still waiting as a refusal when cancelled", async () => {
    const { broker, settled } = setup();
    const a = broker.request(request("a"));
    const b = broker.request(request("b"));
    broker.cancelAll();
    expect([await a, await b]).toEqual([false, false]);
    expect(settled).toEqual(["a:false", "b:false"]);
    expect(broker.waiting).toEqual([]);
  });

  it("refuses at once when the run is already cancelled, and when the run is cancelled while waiting", async () => {
    const { broker, shown } = setup();
    const done = new AbortController();
    done.abort();
    expect(await broker.request(request("a"), done.signal)).toBe(false);
    expect(shown).toEqual([]);

    const live = new AbortController();
    const pending = broker.request(request("b"), live.signal);
    live.abort();
    expect(await pending).toBe(false);
  });

  it("refuses a second question with the same id instead of replacing the first", async () => {
    const { broker } = setup();
    const first = broker.request(request("a"));
    expect(await broker.request(request("a"))).toBe(false);
    broker.answer("a", true);
    expect(await first).toBe(true);
  });
});

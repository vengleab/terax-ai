import { describe, expect, it } from "vitest";
import {
  goBack,
  goForward,
  initialPane,
  navigate,
  refresh,
  sameEndpoint,
  switchEndpoint,
} from "./paneState";

const local = { kind: "local" } as const;
const remote = (profileId: string) => ({ kind: "remote", profileId }) as const;

describe("navigate / back / forward", () => {
  it("records history and clears the selection and filter", () => {
    let pane = initialPane(local, "/a");
    pane = { ...pane, selection: ["/a/x"], view: { ...pane.view, filter: "x" } };
    pane = navigate(pane, "/a/b");
    expect(pane.path).toBe("/a/b");
    expect(pane.back).toEqual(["/a"]);
    expect(pane.selection).toEqual([]);
    expect(pane.view.filter).toBe("");
  });

  it("goes back and forward through the history", () => {
    let pane = initialPane(local, "/a");
    pane = navigate(navigate(pane, "/a/b"), "/a/b/c");
    pane = goBack(pane);
    expect(pane.path).toBe("/a/b");
    pane = goBack(pane);
    expect(pane.path).toBe("/a");
    expect(goBack(pane)).toBe(pane);
    pane = goForward(pane);
    expect(pane.path).toBe("/a/b");
    pane = goForward(pane);
    expect(pane.path).toBe("/a/b/c");
    expect(goForward(pane)).toBe(pane);
  });

  it("a new navigation drops the forward history", () => {
    let pane = navigate(navigate(initialPane(local, "/a"), "/b"), "/c");
    pane = goBack(pane);
    pane = navigate(pane, "/d");
    expect(pane.forward).toEqual([]);
    expect(pane.back).toEqual(["/a", "/b"]);
  });

  it("navigating to the same path only refreshes", () => {
    const pane = initialPane(local, "/a");
    const next = navigate(pane, "/a");
    expect(next.path).toBe("/a");
    expect(next.refreshKey).toBe(pane.refreshKey + 1);
    expect(next.back).toEqual([]);
  });

  it("bounds the history", () => {
    let pane = initialPane(local, "/0");
    for (let i = 1; i <= 80; i += 1) pane = navigate(pane, `/${i}`);
    expect(pane.back.length).toBe(50);
    expect(pane.back[pane.back.length - 1]).toBe("/79");
  });
});

describe("switchEndpoint / refresh / sameEndpoint", () => {
  it("starts a fresh pane on the new endpoint but keeps the view options", () => {
    let pane = initialPane(local, "/a");
    pane = { ...pane, view: { ...pane.view, showHidden: true } };
    const next = switchEndpoint(pane, remote("p1"), "/home/u");
    expect(next.endpoint).toEqual(remote("p1"));
    expect(next.path).toBe("/home/u");
    expect(next.back).toEqual([]);
    expect(next.view.showHidden).toBe(true);
  });

  it("refresh bumps the key without moving", () => {
    const pane = initialPane(local, "/a");
    expect(refresh(pane).refreshKey).toBe(1);
    expect(refresh(pane).path).toBe("/a");
  });

  it("compares endpoints by kind and profile", () => {
    expect(sameEndpoint(local, local)).toBe(true);
    expect(sameEndpoint(local, remote("p"))).toBe(false);
    expect(sameEndpoint(remote("p"), remote("p"))).toBe(true);
    expect(sameEndpoint(remote("p"), remote("q"))).toBe(false);
  });
});

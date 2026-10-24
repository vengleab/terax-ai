import { beforeEach, describe, expect, it } from "vitest";
import { pruneTerminals, useSshTerminals } from "./sshTerminals";

const reset = () => useSshTerminals.setState({ terminals: {} });

describe("useSshTerminals", () => {
  beforeEach(reset);

  it("registers a terminal with no remote folder yet", () => {
    useSshTerminals.getState().register({ tabId: 5, leafId: 9, profileId: "p1", startedAt: 100 });
    expect(useSshTerminals.getState().terminals[5]).toEqual({
      tabId: 5,
      leafId: 9,
      profileId: "p1",
      remoteCwd: null,
      startedAt: 100,
    });
  });

  it("records the remote folder for the leaf that reported it", () => {
    const s = useSshTerminals.getState();
    s.register({ tabId: 1, leafId: 10, profileId: "a" });
    s.register({ tabId: 2, leafId: 20, profileId: "b" });
    useSshTerminals.getState().setRemoteCwd(20, "/srv/app");
    const { terminals } = useSshTerminals.getState();
    expect(terminals[2].remoteCwd).toBe("/srv/app");
    expect(terminals[1].remoteCwd).toBeNull();
  });

  it("ignores a report from a leaf that is not an SSH terminal", () => {
    useSshTerminals.getState().register({ tabId: 1, leafId: 10, profileId: "a" });
    const before = useSshTerminals.getState().terminals;
    useSshTerminals.getState().setRemoteCwd(99, "/etc");
    expect(useSshTerminals.getState().terminals).toBe(before);
  });

  it("does not change state when the folder is the same", () => {
    useSshTerminals.getState().register({ tabId: 1, leafId: 10, profileId: "a" });
    useSshTerminals.getState().setRemoteCwd(10, "/x");
    const before = useSshTerminals.getState().terminals;
    useSshTerminals.getState().setRemoteCwd(10, "/x");
    expect(useSshTerminals.getState().terminals).toBe(before);
  });

  it("forgets a tab and prunes closed ones", () => {
    const s = useSshTerminals.getState();
    s.register({ tabId: 1, leafId: 10, profileId: "a" });
    s.register({ tabId: 2, leafId: 20, profileId: "b" });
    s.register({ tabId: 3, leafId: 30, profileId: "c" });
    useSshTerminals.getState().forget(1);
    expect(Object.keys(useSshTerminals.getState().terminals)).toEqual(["2", "3"]);
    useSshTerminals.getState().prune(new Set([3]));
    expect(Object.keys(useSshTerminals.getState().terminals)).toEqual(["3"]);
  });
});

describe("pruneTerminals", () => {
  it("returns the same object when every tab is still open", () => {
    const terminals = {
      1: { tabId: 1, leafId: 2, profileId: "p", remoteCwd: null, startedAt: 0 },
    };
    expect(pruneTerminals(terminals, new Set([1, 7]))).toBe(terminals);
  });
});

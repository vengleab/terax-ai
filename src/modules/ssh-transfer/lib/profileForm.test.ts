import { describe, expect, it } from "vitest";
import type { SshProfile } from "../types";
import {
  emptyProfileForm,
  isJumpHostForOthers,
  jumpHostCandidates,
  type ProfileFormValues,
  parseTags,
  profileToForm,
  validateProfileForm,
} from "./profileForm";

function form(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    ...emptyProfileForm(),
    name: "Prod",
    host: "example.com",
    user: "deploy",
    ...overrides,
  };
}

function profile(id: string, overrides: Partial<SshProfile> = {}): SshProfile {
  return {
    id,
    name: id,
    host: "example.com",
    port: 22,
    user: "deploy",
    auth: { kind: "agent" },
    jumpHost: null,
    keepaliveSecs: 30,
    color: null,
    tags: [],
    favorite: false,
    defaultRemoteDir: null,
    defaultLocalDir: null,
    source: "manual",
    ...overrides,
  };
}

function errorsOf(values: ProfileFormValues, selfId?: string) {
  const result = validateProfileForm(values, { selfId });
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

describe("validateProfileForm", () => {
  it("accepts the defaults plus a name, host and user", () => {
    const result = validateProfileForm(form());
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Prod",
        host: "example.com",
        port: 22,
        user: "deploy",
        auth: { kind: "agent" },
        jumpHost: null,
        keepaliveSecs: 30,
        color: null,
        tags: [],
        favorite: false,
        defaultRemoteDir: null,
      },
    });
  });

  it("trims text fields and normalizes the color and folder", () => {
    const result = validateProfileForm(
      form({
        name: "  Prod  ",
        host: " example.com ",
        user: " me ",
        port: " 2222 ",
        color: "#A1B2C3",
        defaultRemoteDir: "  /srv/app  ",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      name: "Prod",
      host: "example.com",
      user: "me",
      port: 2222,
      color: "#a1b2c3",
      defaultRemoteDir: "/srv/app",
    });
  });

  it("requires a name of 1 to 80 printable characters", () => {
    expect(errorsOf(form({ name: "   " })).name).toBeDefined();
    expect(errorsOf(form({ name: "x".repeat(81) })).name).toBeDefined();
    expect(errorsOf(form({ name: "a\u0007b" })).name).toBeDefined();
    expect(validateProfileForm(form({ name: "x".repeat(80) })).ok).toBe(true);
  });

  it("counts characters, not UTF-16 units, for the name limit", () => {
    expect(validateProfileForm(form({ name: "\u{1F5A5}".repeat(80) })).ok).toBe(
      true,
    );
  });

  it("rejects hosts that could become ssh options or contain unsafe characters", () => {
    for (const bad of [
      "",
      "   ",
      "-oProxyCommand=x",
      "-p",
      "a b",
      "a;b",
      "a$(x)",
      "host/../x",
      "[::1]",
    ]) {
      expect(errorsOf(form({ host: bad })).host, `host ${bad}`).toBeDefined();
    }
    expect(errorsOf(form({ host: "a".repeat(254) })).host).toBeDefined();
  });

  it("accepts dns names, ipv4 and scoped ipv6 hosts", () => {
    for (const good of [
      "example.com",
      "build-01.internal_net.example",
      "10.0.0.5",
      "fe80::1%eth0",
      "2001:db8::1",
    ]) {
      expect(validateProfileForm(form({ host: good })).ok, good).toBe(true);
    }
  });

  it("rejects users that start with a dash or contain unsafe characters", () => {
    for (const bad of ["", "-l", "a b", "a;b", "a`b`", "u".repeat(65)]) {
      expect(errorsOf(form({ user: bad })).user, `user ${bad}`).toBeDefined();
    }
    for (const good of ["me@corp.example", "svc_deploy", "a+b", "x.y-z"]) {
      expect(validateProfileForm(form({ user: good })).ok, good).toBe(true);
    }
  });

  it("requires an integer port from 1 to 65535", () => {
    for (const bad of [
      "",
      "0",
      "65536",
      "22.5",
      "abc",
      "-1",
      "1e3",
      "99999999999",
    ]) {
      expect(errorsOf(form({ port: bad })).port, `port ${bad}`).toBeDefined();
    }
    for (const good of ["1", "22", "65535"]) {
      expect(validateProfileForm(form({ port: good })).ok, good).toBe(true);
    }
  });

  it("requires keepalive to be an integer from 0 to 3600", () => {
    for (const bad of ["", "-1", "3601", "1.5", "x"]) {
      expect(
        errorsOf(form({ keepaliveSecs: bad })).keepaliveSecs,
        `keepalive ${bad}`,
      ).toBeDefined();
    }
    const zero = validateProfileForm(form({ keepaliveSecs: "0" }));
    expect(zero.ok && zero.value.keepaliveSecs).toBe(0);
    expect(validateProfileForm(form({ keepaliveSecs: "3600" })).ok).toBe(true);
  });

  it("builds the auth method and requires a path for key file auth", () => {
    expect(
      errorsOf(form({ authKind: "keyFile", keyPath: "  " })).keyPath,
    ).toBeDefined();
    expect(
      errorsOf(form({ authKind: "keyFile", keyPath: "a\0b" })).keyPath,
    ).toBeDefined();

    const key = validateProfileForm(
      form({ authKind: "keyFile", keyPath: " ~/.ssh/id_ed25519 " }),
    );
    expect(key.ok && key.value.auth).toEqual({
      kind: "keyFile",
      path: "~/.ssh/id_ed25519",
    });

    const password = validateProfileForm(
      form({ authKind: "password", keyPath: "" }),
    );
    expect(password.ok && password.value.auth).toEqual({ kind: "password" });

    const agent = validateProfileForm(
      form({ authKind: "agent", keyPath: "/ignored" }),
    );
    expect(agent.ok && agent.value.auth).toEqual({ kind: "agent" });
  });

  it("does not demand a key path when another auth method is chosen", () => {
    expect(validateProfileForm(form({ authKind: "password" })).ok).toBe(true);
  });

  it("refuses a server that jumps through itself", () => {
    expect(
      errorsOf(form({ jumpHost: "abcdef12" }), "abcdef12").jumpHost,
    ).toBeDefined();
    const other = validateProfileForm(form({ jumpHost: "fedcba98" }), {
      selfId: "abcdef12",
    });
    expect(other.ok && other.value.jumpHost).toBe("fedcba98");
  });

  it("accepts #rrggbb and short color names and rejects anything else", () => {
    expect(validateProfileForm(form({ color: "#a1B2c3" })).ok).toBe(true);
    expect(validateProfileForm(form({ color: "red" })).ok).toBe(true);
    expect(validateProfileForm(form({ color: null })).ok).toBe(true);
    for (const bad of ["red; drop", "#12345", "#12345g", "a".repeat(17)]) {
      expect(
        errorsOf(form({ color: bad })).color,
        `color ${bad}`,
      ).toBeDefined();
    }
  });

  it("limits the default remote folder to a usable path", () => {
    expect(
      errorsOf(form({ defaultRemoteDir: "a\0b" })).defaultRemoteDir,
    ).toBeDefined();
    expect(
      errorsOf(form({ defaultRemoteDir: "/".padEnd(4097, "a") }))
        .defaultRemoteDir,
    ).toBeDefined();
    const none = validateProfileForm(form({ defaultRemoteDir: "   " }));
    expect(none.ok && none.value.defaultRemoteDir).toBeNull();
  });

  it("limits tags to 16 entries of at most 32 characters", () => {
    const many = Array.from({ length: 17 }, (_, i) => `t${i}`).join(",");
    expect(errorsOf(form({ tags: many })).tags).toBeDefined();
    expect(errorsOf(form({ tags: "x".repeat(33) })).tags).toBeDefined();
    const ok = validateProfileForm(form({ tags: " prod , db,prod,, eu " }));
    expect(ok.ok && ok.value.tags).toEqual(["prod", "db", "eu"]);
  });

  it("reports every problem at once", () => {
    const errors = errorsOf(
      form({ name: "", host: "", user: "", port: "0", keepaliveSecs: "x" }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      "host",
      "keepaliveSecs",
      "name",
      "port",
      "user",
    ]);
  });
});

describe("parseTags", () => {
  it("trims, drops empties and removes duplicates while keeping order", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags(" , ,")).toEqual([]);
    expect(parseTags("b, a,b ,a, c")).toEqual(["b", "a", "c"]);
  });

  it("is case sensitive like the backend", () => {
    expect(parseTags("Prod,prod")).toEqual(["Prod", "prod"]);
  });
});

describe("profileToForm", () => {
  it("round-trips through validation", () => {
    const original = profile("abcdef12", {
      name: "Staging",
      host: "stage.example.com",
      port: 2200,
      user: "ops",
      auth: { kind: "keyFile", path: "/keys/id" },
      jumpHost: "fedcba98",
      keepaliveSecs: 0,
      color: "#3b82f6",
      tags: ["a", "b"],
      favorite: true,
      defaultRemoteDir: "/srv",
    });
    const result = validateProfileForm(profileToForm(original), {
      selfId: original.id,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      name: original.name,
      host: original.host,
      port: original.port,
      user: original.user,
      auth: original.auth,
      jumpHost: original.jumpHost,
      keepaliveSecs: original.keepaliveSecs,
      color: original.color,
      tags: original.tags,
      favorite: original.favorite,
      defaultRemoteDir: original.defaultRemoteDir,
    });
  });
});

describe("jump host helpers", () => {
  const bastion = profile("bastion1");
  const inner = profile("inner001", { jumpHost: "bastion1" });
  const plain = profile("plain001");
  const all = [bastion, inner, plain];

  it("offers other servers that have no jump host of their own", () => {
    expect(jumpHostCandidates(all, "plain001").map((p) => p.id)).toEqual([
      "bastion1",
    ]);
    expect(jumpHostCandidates(all).map((p) => p.id)).toEqual([
      "bastion1",
      "plain001",
    ]);
  });

  it("detects a server that others jump through", () => {
    expect(isJumpHostForOthers(all, "bastion1")).toBe(true);
    expect(isJumpHostForOthers(all, "plain001")).toBe(false);
  });
});

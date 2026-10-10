import { describe, expect, it } from "vitest";
import type { ForwardSpec } from "../types";
import {
  changeForwardType,
  describeForward,
  emptyForwardForm,
  type ForwardFormValues,
  forwardToForm,
  isLoopbackHost,
  validateForwardForm,
} from "./forwardForm";

const context = { profileId: "abcdef12" };

function local(overrides: Partial<ForwardFormValues> = {}): ForwardFormValues {
  return {
    ...emptyForwardForm("local"),
    name: "Postgres",
    port: "5432",
    destHost: "db.internal",
    destPort: "5432",
    ...overrides,
  };
}

function remote(overrides: Partial<ForwardFormValues> = {}): ForwardFormValues {
  return {
    ...emptyForwardForm("remote"),
    name: "Dev server",
    port: "9000",
    destPort: "3000",
    ...overrides,
  };
}

function dynamic(
  overrides: Partial<ForwardFormValues> = {},
): ForwardFormValues {
  return {
    ...emptyForwardForm("dynamic"),
    name: "SOCKS",
    port: "1080",
    ...overrides,
  };
}

function errorsOf(values: ForwardFormValues) {
  const result = validateForwardForm(values, context);
  if (result.ok) throw new Error("expected validation to fail");
  return result.errors;
}

describe("isLoopbackHost", () => {
  it("accepts localhost, 127.x.x.x and ::1 in any common spelling", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      " localhost ",
      "127.0.0.1",
      "127.255.255.254",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const host of [
      "",
      "0.0.0.0",
      "::",
      "128.0.0.1",
      "127.0.0",
      "127.1",
      "127.0.0.256",
      "127.00.0.1",
      "10.0.0.5",
      "192.168.1.2",
      "example.com",
      "localhost.localdomain",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("validateForwardForm", () => {
  it("builds a local forward", () => {
    expect(validateForwardForm(local(), context)).toEqual({
      ok: true,
      value: {
        profileId: "abcdef12",
        name: "Postgres",
        autostart: false,
        expose: false,
        kind: "local",
        listenHost: "127.0.0.1",
        listenPort: 5432,
        destHost: "db.internal",
        destPort: 5432,
      },
    });
  });

  it("builds a remote forward with the server side bind address", () => {
    expect(validateForwardForm(remote(), context)).toEqual({
      ok: true,
      value: {
        profileId: "abcdef12",
        name: "Dev server",
        autostart: false,
        expose: false,
        kind: "remote",
        bindHost: "127.0.0.1",
        bindPort: 9000,
        destHost: "localhost",
        destPort: 3000,
      },
    });
  });

  it("builds a dynamic forward without a destination", () => {
    const result = validateForwardForm(
      dynamic({ destHost: "ignored", destPort: "bad" }),
      context,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        profileId: "abcdef12",
        name: "SOCKS",
        autostart: false,
        expose: false,
        kind: "dynamic",
        listenHost: "127.0.0.1",
        listenPort: 1080,
      },
    });
  });

  it("carries the id and autostart flag through an edit", () => {
    const result = validateForwardForm(local(), {
      profileId: "abcdef12",
      id: "0123abcd",
      autostart: true,
    });
    expect(result.ok && result.value).toMatchObject({
      id: "0123abcd",
      autostart: true,
    });
  });

  it("allows port 0 for the listener but never for the destination", () => {
    const free = validateForwardForm(local({ port: "0" }), context);
    expect(free.ok && free.value).toMatchObject({ listenPort: 0 });
    expect(errorsOf(local({ destPort: "0" })).destPort).toBeDefined();
    expect(validateForwardForm(remote({ port: "0" }), context).ok).toBe(true);
  });

  it("rejects ports outside the valid range or that are not integers", () => {
    for (const bad of ["", "-1", "65536", "80.5", "abc", "1e3", "100000"]) {
      expect(
        errorsOf(local({ port: bad })).port,
        `listen ${bad}`,
      ).toBeDefined();
      expect(
        errorsOf(local({ destPort: bad })).destPort,
        `dest ${bad}`,
      ).toBeDefined();
    }
    expect(validateForwardForm(local({ port: "65535" }), context).ok).toBe(
      true,
    );
  });

  it("requires a name and non-empty hosts", () => {
    expect(errorsOf(local({ name: "  " })).name).toBeDefined();
    expect(errorsOf(local({ name: "x".repeat(81) })).name).toBeDefined();
    expect(errorsOf(local({ host: "" })).host).toBeDefined();
    expect(errorsOf(local({ destHost: " " })).destHost).toBeDefined();
    expect(errorsOf(remote({ destHost: "" })).destHost).toBeDefined();
  });

  it("rejects hosts with unsafe characters or a leading dash", () => {
    for (const bad of ["-x", "a b", "a;b", "a/b"]) {
      expect(
        errorsOf(local({ host: bad })).host,
        `listen ${bad}`,
      ).toBeDefined();
      expect(
        errorsOf(local({ destHost: bad })).destHost,
        `dest ${bad}`,
      ).toBeDefined();
    }
  });

  it("accepts a bracketed ipv6 listen address like the backend", () => {
    const result = validateForwardForm(local({ host: "[::1]" }), context);
    expect(result.ok && result.value).toMatchObject({ listenHost: "[::1]" });
  });

  it("requires expose for a non-loopback listener on a local or dynamic forward", () => {
    expect(errorsOf(local({ host: "0.0.0.0" })).expose).toBeDefined();
    expect(errorsOf(dynamic({ host: "192.168.1.5" })).expose).toBeDefined();

    const exposed = validateForwardForm(
      local({ host: "0.0.0.0", expose: true }),
      context,
    );
    expect(exposed.ok && exposed.value.expose).toBe(true);
  });

  it("does not ask for expose when the host is already invalid", () => {
    expect(errorsOf(local({ host: "a b" })).expose).toBeUndefined();
  });

  it("drops a stale expose flag when the listener is loopback", () => {
    const result = validateForwardForm(local({ expose: true }), context);
    expect(result.ok && result.value.expose).toBe(false);
  });

  it("never asks for expose on a remote forward, where the bind address is on the server", () => {
    const result = validateForwardForm(remote({ host: "0.0.0.0" }), context);
    expect(result.ok && result.value.expose).toBe(false);
  });

  it("reports every problem at once", () => {
    const errors = errorsOf(
      local({ name: "", host: "", port: "x", destHost: "", destPort: "0" }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      "destHost",
      "destPort",
      "host",
      "name",
      "port",
    ]);
  });
});

describe("changeForwardType", () => {
  it("fills the default destination host for a remote forward", () => {
    const next = changeForwardType(emptyForwardForm("local"), "remote");
    expect(next.type).toBe("remote");
    expect(next.destHost).toBe("localhost");
  });

  it("clears the default destination host when leaving a remote forward", () => {
    const next = changeForwardType(emptyForwardForm("remote"), "local");
    expect(next.destHost).toBe("");
  });

  it("keeps values the user typed", () => {
    const typed = local({
      host: "0.0.0.0",
      destHost: "db.internal",
      name: "n",
    });
    const next = changeForwardType(typed, "remote");
    expect(next).toMatchObject({
      type: "remote",
      host: "0.0.0.0",
      destHost: "db.internal",
      name: "n",
    });
  });
});

describe("describeForward", () => {
  it("describes a local forward", () => {
    expect(
      describeForward({
        kind: "local",
        listenHost: "127.0.0.1",
        listenPort: 8080,
        destHost: "db.internal",
        destPort: 5432,
      }),
    ).toBe("127.0.0.1:8080 -> db.internal:5432");
  });

  it("describes a remote forward from the server's point of view", () => {
    expect(
      describeForward({
        kind: "remote",
        bindHost: "127.0.0.1",
        bindPort: 9000,
        destHost: "localhost",
        destPort: 3000,
      }),
    ).toBe("server:9000 -> localhost:3000");
    expect(
      describeForward({
        kind: "remote",
        bindHost: "0.0.0.0",
        bindPort: 9000,
        destHost: "localhost",
        destPort: 3000,
      }),
    ).toBe("server 0.0.0.0:9000 -> localhost:3000");
  });

  it("describes a dynamic forward", () => {
    expect(
      describeForward({
        kind: "dynamic",
        listenHost: "127.0.0.1",
        listenPort: 1080,
      }),
    ).toBe("SOCKS5 on 127.0.0.1:1080");
  });

  it("shows auto for port 0 and brackets ipv6 hosts", () => {
    expect(
      describeForward({
        kind: "local",
        listenHost: "::1",
        listenPort: 0,
        destHost: "fe80::1",
        destPort: 22,
      }),
    ).toBe("[::1]:auto -> [fe80::1]:22");
    expect(
      describeForward({
        kind: "dynamic",
        listenHost: "[::1]",
        listenPort: 1080,
      }),
    ).toBe("SOCKS5 on [::1]:1080");
  });

  it("accepts a full spec", () => {
    const spec: ForwardSpec = {
      id: "0123abcd",
      profileId: "abcdef12",
      name: "n",
      autostart: false,
      expose: false,
      kind: "local",
      listenHost: "localhost",
      listenPort: 1,
      destHost: "h",
      destPort: 2,
    };
    expect(describeForward(spec)).toBe("localhost:1 -> h:2");
  });
});

describe("forwardToForm", () => {
  const specs: ForwardSpec[] = [
    {
      id: "0123abcd",
      profileId: "abcdef12",
      name: "a",
      autostart: true,
      expose: true,
      kind: "local",
      listenHost: "0.0.0.0",
      listenPort: 8080,
      destHost: "db",
      destPort: 5432,
    },
    {
      id: "0123abce",
      profileId: "abcdef12",
      name: "b",
      autostart: false,
      expose: false,
      kind: "remote",
      bindHost: "127.0.0.1",
      bindPort: 9000,
      destHost: "localhost",
      destPort: 3000,
    },
    {
      id: "0123abcf",
      profileId: "abcdef12",
      name: "c",
      autostart: false,
      expose: false,
      kind: "dynamic",
      listenHost: "127.0.0.1",
      listenPort: 1080,
    },
  ];

  it("round-trips every kind through validation", () => {
    for (const spec of specs) {
      const result = validateForwardForm(forwardToForm(spec), {
        profileId: spec.profileId,
        id: spec.id,
        autostart: spec.autostart,
      });
      expect(result.ok && result.value, spec.name).toEqual(spec);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  DeviceFlowError,
  parseDeviceCode,
  parsePollResponse,
  pollForToken,
  requestDeviceCode,
  type DeviceCode,
} from "./deviceFlow";

const code: DeviceCode = {
  deviceCode: "dev-123",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
  interval: 5,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("parseDeviceCode", () => {
  it("reads a GitHub device code response", () => {
    expect(
      parseDeviceCode({
        device_code: "dev-123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    ).toEqual(code);
  });

  it("falls back to sane timings", () => {
    const parsed = parseDeviceCode({
      device_code: "d",
      user_code: "u",
      verification_uri: "https://github.com/login/device",
    });
    expect(parsed.expiresIn).toBe(900);
    expect(parsed.interval).toBe(5);
  });

  it("rejects an error response with GitHub's reason", () => {
    expect(() =>
      parseDeviceCode({ error: "unauthorized_client", error_description: "nope" }),
    ).toThrow(/did not return a device code: nope/);
    expect(() => parseDeviceCode(null)).toThrow(DeviceFlowError);
  });
});

describe("parsePollResponse", () => {
  it("maps every documented outcome", () => {
    expect(parsePollResponse({ access_token: "gho_x" })).toEqual({
      status: "done",
      accessToken: "gho_x",
    });
    expect(parsePollResponse({ error: "authorization_pending" }).status).toBe("pending");
    expect(parsePollResponse({ error: "slow_down", interval: 10 })).toEqual({
      status: "slow_down",
      interval: 10,
    });
    expect(parsePollResponse({ error: "access_denied" }).status).toBe("denied");
    expect(parsePollResponse({ error: "expired_token" }).status).toBe("expired");
    expect(
      parsePollResponse({ error: "bad", error_description: "Something broke" }),
    ).toEqual({ status: "error", message: "Something broke" });
    expect(parsePollResponse("x").status).toBe("error");
  });
});

describe("requestDeviceCode", () => {
  it("posts the client id with a minimal scope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        device_code: "d",
        user_code: "u",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );
    await requestDeviceCode(fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://github.com/login/device/code");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      client_id: "Iv1.b507a08c87ecfe98",
      scope: "read:user",
    });
    expect(init.headers.Accept).toBe("application/json");
  });

  it("fails clearly when GitHub answers without JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>", { status: 502 }));
    await expect(
      requestDeviceCode(fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 502 without JSON/);
  });
});

describe("pollForToken", () => {
  function setup(responses: unknown[]) {
    const fetchImpl = vi.fn();
    for (const r of responses) fetchImpl.mockResolvedValueOnce(json(r));
    const sleeps: number[] = [];
    let clock = 0;
    return {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mock: fetchImpl,
      sleeps,
      options: {
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
        now: () => clock,
      },
    };
  }

  it("waits through pending, then returns the token", async () => {
    const t = setup([
      { error: "authorization_pending" },
      { error: "authorization_pending" },
      { access_token: "gho_ok" },
    ]);
    await expect(
      pollForToken(code, { ...t.options, fetchImpl: t.fetchImpl }),
    ).resolves.toBe("gho_ok");
    expect(t.sleeps).toEqual([5000, 5000, 5000]);
    const body = JSON.parse(t.mock.mock.calls[0][1].body);
    expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.device_code).toBe("dev-123");
  });

  it("backs off on slow_down, using GitHub's interval when given", async () => {
    const t = setup([
      { error: "slow_down", interval: 12 },
      { error: "slow_down" },
      { access_token: "gho_ok" },
    ]);
    await pollForToken(code, { ...t.options, fetchImpl: t.fetchImpl });
    expect(t.sleeps).toEqual([5000, 12000, 17000]);
  });

  it("stops on denial", async () => {
    const t = setup([{ error: "access_denied" }]);
    await expect(
      pollForToken(code, { ...t.options, fetchImpl: t.fetchImpl }),
    ).rejects.toMatchObject({ kind: "denied" });
  });

  it("stops when the code expires", async () => {
    const t = setup([{ error: "expired_token" }]);
    await expect(
      pollForToken(code, { ...t.options, fetchImpl: t.fetchImpl }),
    ).rejects.toMatchObject({ kind: "expired" });

    const slow = setup([]);
    await expect(
      pollForToken(
        { ...code, expiresIn: 3, interval: 5 },
        { ...slow.options, fetchImpl: slow.fetchImpl },
      ),
    ).rejects.toMatchObject({ kind: "expired" });
    expect(slow.mock.mock.calls).toHaveLength(0);
  });

  it("honours cancellation before asking GitHub again", async () => {
    const controller = new AbortController();
    const t = setup([]);
    controller.abort();
    await expect(
      pollForToken(code, {
        ...t.options,
        fetchImpl: t.fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(t.mock.mock.calls).toHaveLength(0);
  });
});

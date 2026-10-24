import { proxyFetch } from "../../lib/proxyFetch";
import {
  COPILOT_CLIENT_ID,
  COPILOT_USER_AGENT,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
} from "./constants";

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DeviceFlowFailure = "denied" | "expired" | "cancelled" | "failed";

export class DeviceFlowError extends Error {
  constructor(
    readonly kind: DeviceFlowFailure,
    message: string,
  ) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

export type PollOutcome =
  | { status: "pending" }
  | { status: "slow_down"; interval: number | null }
  | { status: "done"; accessToken: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function parseDeviceCode(json: unknown): DeviceCode {
  const o = asRecord(json);
  const deviceCode = o?.device_code;
  const userCode = o?.user_code;
  const verificationUri = o?.verification_uri;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    !deviceCode ||
    !userCode
  ) {
    const reason =
      typeof o?.error_description === "string" ? `: ${o.error_description}` : "";
    throw new DeviceFlowError(
      "failed",
      `GitHub did not return a device code${reason}`,
    );
  }
  const expiresIn =
    typeof o?.expires_in === "number" && o.expires_in > 0 ? o.expires_in : 900;
  const interval =
    typeof o?.interval === "number" && o.interval > 0
      ? o.interval
      : DEFAULT_INTERVAL_S;
  return { deviceCode, userCode, verificationUri, expiresIn, interval };
}

export function parsePollResponse(json: unknown): PollOutcome {
  const o = asRecord(json);
  if (!o) return { status: "error", message: "Unreadable response from GitHub" };
  if (typeof o.access_token === "string" && o.access_token) {
    return { status: "done", accessToken: o.access_token };
  }
  switch (o.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return {
        status: "slow_down",
        interval: typeof o.interval === "number" ? o.interval : null,
      };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default: {
      const message =
        typeof o.error_description === "string"
          ? o.error_description
          : typeof o.error === "string"
            ? o.error
            : "Unexpected response from GitHub";
      return { status: "error", message };
    }
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, string>,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": COPILOT_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeviceFlowError(
      "failed",
      `GitHub returned HTTP ${res.status} without JSON`,
    );
  }
}

export async function requestDeviceCode(
  fetchImpl: typeof fetch = proxyFetch,
): Promise<DeviceCode> {
  const json = await postJson(fetchImpl, GITHUB_DEVICE_CODE_URL, {
    client_id: COPILOT_CLIENT_ID,
    scope: "read:user",
  });
  return parseDeviceCode(json);
}

export type PollOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function pollForToken(
  code: DeviceCode,
  options: PollOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? proxyFetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let intervalS = Math.max(code.interval, 1);

  for (;;) {
    await sleep(intervalS * 1000, options.signal);
    if (options.signal?.aborted) {
      throw new DeviceFlowError("cancelled", "Sign-in cancelled");
    }
    if (now() >= deadline) {
      throw new DeviceFlowError("expired", "The sign-in code expired");
    }
    const outcome = parsePollResponse(
      await postJson(fetchImpl, GITHUB_ACCESS_TOKEN_URL, {
        client_id: COPILOT_CLIENT_ID,
        device_code: code.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    switch (outcome.status) {
      case "pending":
        break;
      case "slow_down":
        intervalS = Math.max(
          outcome.interval ?? intervalS + SLOW_DOWN_STEP_S,
          intervalS + 1,
        );
        break;
      case "done":
        return outcome.accessToken;
      case "denied":
        throw new DeviceFlowError("denied", "GitHub sign-in was declined");
      case "expired":
        throw new DeviceFlowError("expired", "The sign-in code expired");
      case "error":
        throw new DeviceFlowError("failed", outcome.message);
    }
  }
}

import { describe, expect, it, vi } from "vitest";
import {
  accountSummary,
  base64Url,
  createTokenManager,
  DEFAULT_TOKEN_URI,
  fetchAccessToken,
  parseServiceAccount,
  pemToDer,
  safeTokenUri,
  signJwt,
  VertexAuthError,
} from "./serviceAccount";
import { makeTestAccount } from "./testKey";

const NOW_MS = 1_800_000_000_000;

const tokenResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function decodePart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("parseServiceAccount", () => {
  it("reads a downloaded key file", async () => {
    const { json } = await makeTestAccount();
    const sa = parseServiceAccount(json);
    expect(sa.clientEmail).toBe("terax@demo-project-123.iam.gserviceaccount.com");
    expect(sa.projectId).toBe("demo-project-123");
    expect(sa.tokenUri).toBe("https://oauth2.googleapis.com/token");
    expect(sa.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(accountSummary(sa)).toEqual({
      clientEmail: "terax@demo-project-123.iam.gserviceaccount.com",
      projectId: "demo-project-123",
    });
  });

  it("explains what is wrong without echoing the key", async () => {
    const { parsed } = await makeTestAccount();
    const attempts: [string, string][] = [
      ["not json", "not a JSON file"],
      [JSON.stringify({ ...parsed, type: "authorized_user" }), "not a service account key"],
      [JSON.stringify({ ...parsed, client_email: undefined }), "client_email"],
      [JSON.stringify({ ...parsed, private_key: "-----BEGIN RSA PRIVATE KEY-----\nabc" }), "private_key"],
      [JSON.stringify({ ...parsed, project_id: "  " }), "project_id"],
      [JSON.stringify([]), "not a service account key"],
    ];
    for (const [text, expected] of attempts) {
      let message = "";
      try {
        parseServiceAccount(text);
      } catch (error) {
        expect(error).toBeInstanceOf(VertexAuthError);
        message = (error as Error).message;
      }
      expect(message).toContain(expected);
      expect(message).not.toContain(parsed.private_key.slice(40, 80));
    }
  });

  it("only trusts a Google https token endpoint", async () => {
    const { parsed } = await makeTestAccount();
    expect(safeTokenUri("https://oauth2.googleapis.com/token")).toBe("https://oauth2.googleapis.com/token");
    for (const bad of ["http://oauth2.googleapis.com/token", "https://evil.example.com/token", "https://googleapis.com.evil.io/t", "nope", undefined]) {
      expect(safeTokenUri(bad)).toBe(DEFAULT_TOKEN_URI);
    }
    const sa = parseServiceAccount(JSON.stringify({ ...parsed, token_uri: "https://evil.example.com/token" }));
    expect(sa.tokenUri).toBe(DEFAULT_TOKEN_URI);
  });
});

describe("signJwt", () => {
  it("produces an RS256 token that the matching public key verifies", async () => {
    const { json, publicKey } = await makeTestAccount();
    const sa = parseServiceAccount(json);
    const jwt = await signJwt(sa, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");

    expect(decodePart(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const body = decodePart(claims);
    expect(body.iss).toBe(sa.clientEmail);
    expect(body.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(body.aud).toBe("https://oauth2.googleapis.com/token");
    expect(body.iat).toBe(1_800_000_000 - 30);
    expect(body.exp).toBe((body.iat as number) + 3600);

    const raw = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      raw,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it("rejects a key that is not valid RSA", async () => {
    const { parsed } = await makeTestAccount();
    const sa = parseServiceAccount(
      JSON.stringify({ ...parsed, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" }),
    );
    await expect(signJwt(sa, 1_800_000_000)).rejects.toThrow(/not a valid RSA key/);
  });

  it("helpers: base64url and pem decoding", () => {
    expect(base64Url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect([...pemToDer("-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n")]).toEqual([1, 2, 3]);
    expect(() => pemToDer("-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----")).toThrow(VertexAuthError);
  });
});

describe("fetchAccessToken", () => {
  it("posts the signed assertion as a form and reads the token and lifetime", async () => {
    const { json } = await makeTestAccount();
    const sa = parseServiceAccount(json);
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse({ access_token: "ya29.demo", expires_in: 1800 }));
    const token = await fetchAccessToken(sa, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW_MS });

    expect(token).toEqual({ accessToken: "ya29.demo", expiresAtMs: NOW_MS + 1_800_000 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
  });

  it("surfaces Google's reason when the account is rejected", async () => {
    const { json } = await makeTestAccount();
    const sa = parseServiceAccount(json);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(tokenResponse({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400));
    await expect(
      fetchAccessToken(sa, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW_MS }),
    ).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("Invalid JWT Signature.") });
  });

  it("reports a network failure and a response without a token", async () => {
    const { json } = await makeTestAccount();
    const sa = parseServiceAccount(json);
    await expect(
      fetchAccessToken(sa, { fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(
      fetchAccessToken(sa, { fetchImpl: (async () => tokenResponse({})) as unknown as typeof fetch }),
    ).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("createTokenManager", () => {
  it("reuses a token until shortly before it expires, shares concurrent requests and can be invalidated", async () => {
    const { json } = await makeTestAccount();
    const sa = parseServiceAccount(json);
    let clock = NOW_MS;
    let n = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => tokenResponse({ access_token: `t${++n}`, expires_in: 600 }));
    const manager = createTokenManager(sa, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });

    const [a, b] = await Promise.all([manager.get(), manager.get()]);
    expect([a, b]).toEqual(["t1", "t1"]);
    expect(await manager.get()).toBe("t1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 9 * 60_000 + 30_000;
    expect(await manager.get()).toBe("t2");
    manager.invalidate();
    expect(await manager.get()).toBe("t3");
  });
});

import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  type CredentialDeps,
  chunkAccount,
  fingerprint,
  loadAccountText,
  makePointer,
  parsePointer,
  removeAccountParts,
  splitIntoChunks,
  storeAccountText,
} from "./credentialStore";
import { makeTestAccount } from "./testKey";

const WINDOWS_LIMIT_CHARS = 1280;

function fakeDeps() {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const deps: CredentialDeps = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(`${cmd}:${args?.account}`);
      if (cmd === "secrets_set") secrets.set(args?.account as string, args?.password as string);
      if (cmd === "secrets_delete") secrets.delete(args?.account as string);
      return null;
    }) as CredentialDeps["invoke"],
    resolve: async (marker: string) => secrets.get(marker.slice(marker.lastIndexOf(":") + 1)) ?? null,
  };
  return { secrets, calls, deps };
}

describe("splitIntoChunks", () => {
  it("round-trips and respects the size", () => {
    const text = "x".repeat(2500);
    const chunks = splitIntoChunks(text);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks.join("")).toBe(text);
    expect(splitIntoChunks("")).toEqual([]);
  });
});

describe("pointers", () => {
  it("round-trips and rejects other text", () => {
    const pointer = makePointer(3, "0123456789ab");
    expect(pointer).toBe("vertex-sa:v1:3:0123456789ab");
    expect(parsePointer(pointer)).toEqual({ parts: 3, print: "0123456789ab" });
    for (const bad of ["", "{}", "vertex-sa:v1:0:0123456789ab", "vertex-sa:v1:3:XYZ", "vertex-sa:v2:3:0123456789ab", "sk-live"]) {
      expect(parsePointer(bad)).toBeNull();
    }
  });

  it("changes when the key file changes", async () => {
    expect(await fingerprint("a")).toMatch(/^[0-9a-f]{12}$/);
    expect(await fingerprint("a")).toBe(await fingerprint("a"));
    expect(await fingerprint("a")).not.toBe(await fingerprint("b"));
  });
});

describe("storing a real-sized key file", () => {
  it("keeps every entry under the Windows credential limit and reads back the exact file", async () => {
    const { json } = await makeTestAccount();
    expect(json.length).toBeGreaterThan(WINDOWS_LIMIT_CHARS);
    const { secrets, deps } = fakeDeps();

    const pointer = await storeAccountText(json, 0, deps);
    expect(parsePointer(pointer)?.parts).toBe(secrets.size);
    expect(secrets.size).toBeGreaterThan(1);
    for (const value of secrets.values()) {
      expect(value.length).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(value.length).toBeLessThan(WINDOWS_LIMIT_CHARS);
    }
    expect(await loadAccountText(pointer, deps)).toBe(json);
  });

  it("removes leftover parts when a shorter key replaces a longer one", async () => {
    const { secrets, calls, deps } = fakeDeps();
    await storeAccountText("x".repeat(3500), 0, deps);
    expect(secrets.size).toBe(4);
    const pointer = await storeAccountText("y".repeat(1200), 4, deps);
    expect(secrets.size).toBe(2);
    expect(secrets.has(chunkAccount(3))).toBe(false);
    expect(calls).toContain(`secrets_delete:${chunkAccount(3)}`);
    expect(await loadAccountText(pointer, deps)).toBe("y".repeat(1200));
  });

  it("gives a different pointer for a different key file of the same length", async () => {
    const { deps } = fakeDeps();
    const a = await storeAccountText("a".repeat(2000), 0, deps);
    const b = await storeAccountText("b".repeat(2000), 2, deps);
    expect(a).not.toBe(b);
  });
});

describe("loading", () => {
  it("explains a pointer in an unknown format and a missing part", async () => {
    const { secrets, deps } = fakeDeps();
    await expect(loadAccountText("not-a-pointer", deps)).rejects.toThrow(/unknown format/);
    const pointer = await storeAccountText("z".repeat(2100), 0, deps);
    secrets.delete(chunkAccount(1));
    await expect(loadAccountText(pointer, deps)).rejects.toThrow(/missing from your keychain/);
  });

  it("removes all parts", async () => {
    const { secrets, deps } = fakeDeps();
    await storeAccountText("z".repeat(2100), 0, deps);
    await removeAccountParts(3, deps);
    expect(secrets.size).toBe(0);
  });
});

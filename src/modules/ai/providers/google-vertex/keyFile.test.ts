import { describe, expect, it, vi } from "vitest";
import { readServiceAccountFile } from "./keyFile";
import { VertexAuthError } from "./serviceAccount";
import { makeTestAccount } from "./testKey";

const text = (content: string) => ({ kind: "text", content, size: content.length, mtime: 0 });

describe("readServiceAccountFile", () => {
  it("reads the chosen file from the local disk and returns the account", async () => {
    const { json } = await makeTestAccount();
    const invoke = vi.fn().mockResolvedValue(text(json));
    const sa = await readServiceAccountFile("/home/me/Downloads/key.json", { invoke });
    expect(sa.clientEmail).toBe("terax@demo-project-123.iam.gserviceaccount.com");
    expect(invoke).toHaveBeenCalledWith("fs_read_file", {
      path: "/home/me/Downloads/key.json",
      workspace: { kind: "local" },
      force: false,
    });
  });

  it("names the file when it cannot be read", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("No such file or directory"));
    await expect(readServiceAccountFile("/gone.json", { invoke })).rejects.toMatchObject({
      kind: "invalid_key",
      message: "Could not read /gone.json: No such file or directory",
    });
  });

  it("rejects a binary or oversized file as not a key", async () => {
    for (const result of [{ kind: "binary", size: 10 }, { kind: "toolarge", size: 10_000_000, limit: 1_000_000 }]) {
      const invoke = vi.fn().mockResolvedValue(result);
      await expect(readServiceAccountFile("/photo.json", { invoke })).rejects.toThrow(/not a service account key file/);
    }
  });

  it("explains a JSON file that is not a service account key, without echoing its content", async () => {
    const invoke = vi.fn().mockResolvedValue(text(JSON.stringify({ type: "authorized_user", refresh_token: "secret-token-value" })));
    const error = await readServiceAccountFile("/adc.json", { invoke }).catch((e) => e);
    expect(error).toBeInstanceOf(VertexAuthError);
    expect(error.message).toContain("not a service account key");
    expect(error.message).not.toContain("secret-token-value");
  });
});

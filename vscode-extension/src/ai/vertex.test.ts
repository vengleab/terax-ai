import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tool } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatEvent } from "../../shared/chat";
import { runAgent } from "./agent";
import { ChatSetupError } from "./model";
import { type AiSettings, effectiveModel } from "./settings";
import { createVertexModel, expandHome, readKeyFile } from "./vertex";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let dir: string;
let keyFile: string;

function writeKey(over: Record<string, unknown> = {}, file = keyFile): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "service_account",
      project_id: "my-proj",
      private_key_id: "abc123",
      private_key: privateKey,
      client_email: "terax@my-proj.iam.gserviceaccount.com",
      token_uri: TOKEN_URL,
      ...over,
    }),
  );
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "terax-vertex-"));
  keyFile = path.join(dir, "key.json");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => writeKey());

const settings = (over: Partial<AiSettings["vertex"]> = {}, model = ""): AiSettings => ({
  provider: "google-vertex",
  model,
  baseUrl: "",
  maxSteps: 5,
  commandTimeoutSeconds: 10,
  vertex: { keyFile, location: "global", project: "", ...over },
});

type Reply = { text?: string; tool?: string; args?: object; status?: number };

function sse(reply: Reply, id: string): Response {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "g", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let body = chunk({ role: "assistant", content: "" });
  for (const word of reply.text?.match(/\S+\s*/g) ?? []) body += chunk({ content: word });
  if (reply.tool) {
    body += chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] });
  }
  body += chunk({}, reply.tool ? "tool_calls" : "stop");
  body += "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Stands in for Google: a token endpoint that checks the signed request, and a Vertex endpoint that plays a script. */
function fakeGoogle(script: Reply[] = [{ text: "Hello from Vertex." }]) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const tokens: { assertion: string; token: string }[] = [];
  let chat = 0;
  const behaviour = { tokenStatus: 200, tokenError: "", fail: false };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (behaviour.fail) throw new TypeError("fetch failed");
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, headers, body });
    if (url.endsWith("/token")) {
      if (behaviour.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: behaviour.tokenError }), { status: behaviour.tokenStatus });
      }
      const assertion = new URLSearchParams(body).get("assertion") ?? "";
      const token = `ya29.token-${tokens.length + 1}`;
      tokens.push({ assertion, token });
      return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
    }
    const reply = script[Math.min(chat++, script.length - 1)];
    if (reply.status) return new Response(JSON.stringify({ error: { message: "denied" } }), { status: reply.status });
    return sse(reply, `call-${chat}`);
  };
  return { fetchImpl, calls, tokens, behaviour, chatCalls: () => calls.filter((c) => !c.url.endsWith("/token")) };
}

const echo = tool({ description: "echo", inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => ({ echoed: text }) });

async function run(google: ReturnType<typeof fakeGoogle>, s: AiSettings = settings()) {
  const model = await createVertexModel(s, { fetchImpl: google.fetchImpl });
  const events: ChatEvent[] = [];
  const result = await runAgent({
    model,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: { echo },
    maxSteps: 5,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  });
  return { events, result };
}

const answer = (events: ChatEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");

describe("signing in", () => {
  it("proves who it is with a JWT signed by the key file's private key", async () => {
    const google = fakeGoogle();
    await run(google);
    const [{ assertion }] = google.tokens;
    const [header, claims, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
      iss: "terax@my-proj.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: TOKEN_URL,
    });
  });

  it("sends the access token, not the key, with each request", async () => {
    const google = fakeGoogle();
    await run(google);
    expect(google.chatCalls()[0].headers.authorization).toBe("Bearer ya29.token-1");
    for (const call of google.calls) {
      expect(call.body).not.toContain("BEGIN PRIVATE KEY");
      expect(JSON.stringify(call.headers)).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("only signs in at Google, even if the key file names another address", async () => {
    writeKey({ token_uri: "https://evil.example/token" });
    const google = fakeGoogle();
    await run(google);
    expect(google.calls.filter((c) => c.url.endsWith("/token")).every((c) => c.url === TOKEN_URL)).toBe(true);
  });

  it("signs in once and reuses the token for the next requests", async () => {
    const google = fakeGoogle([{ tool: "echo", args: { text: "x" } }, { text: "Done." }]);
    await run(google);
    expect(google.chatCalls()).toHaveLength(2);
    expect(google.tokens).toHaveLength(1);
  });

  it("signs in again, and retries once, when Vertex says the token is no good", async () => {
    const google = fakeGoogle([{ status: 401 }, { text: "Back again." }]);
    const { events } = await run(google);
    expect(answer(events)).toBe("Back again.");
    expect(google.tokens).toHaveLength(2);
    expect(google.chatCalls().map((c) => c.headers.authorization)).toEqual(["Bearer ya29.token-1", "Bearer ya29.token-2"]);
  });
});

describe("the request", () => {
  it("goes to the global Vertex AI address, in the key file's project, with a Gemini model", async () => {
    const google = fakeGoogle();
    const { events } = await run(google);
    const call = google.chatCalls()[0];
    expect(call.url).toBe("https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi/chat/completions");
    expect(JSON.parse(call.body).model).toBe("google/gemini-2.5-flash");
    expect(answer(events)).toBe("Hello from Vertex.");
  });

  it("uses the location, project and model that were set", async () => {
    const google = fakeGoogle();
    await run(google, settings({ location: "europe-west4", project: "billing-proj" }, "gemini-2.5-pro"));
    const call = google.chatCalls()[0];
    expect(call.url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/billing-proj/locations/europe-west4/endpoints/openapi/chat/completions");
    expect(JSON.parse(call.body).model).toBe("google/gemini-2.5-pro");
  });

  it("offers the model the tools, and carries a tool result back", async () => {
    const google = fakeGoogle([{ text: "Checking. ", tool: "echo", args: { text: "ping" } }, { text: "It said ping." }]);
    const { events, result } = await run(google);
    expect(JSON.parse(google.chatCalls()[0].body).tools[0].function.name).toBe("echo");
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ output: { echoed: "ping" }, isError: false });
    expect(google.chatCalls()[1].body).toContain("echoed");
    expect(result.finished).toBe(true);
  });

  it("uses Gemini Flash when no model is chosen", () => {
    expect(effectiveModel(settings())).toBe("gemini-2.5-flash");
    expect(effectiveModel(settings({}, "gemini-2.5-pro"))).toBe("gemini-2.5-pro");
  });
});

describe("when something is wrong, it says what and where to fix it", () => {
  const failure = async (s: AiSettings, google = fakeGoogle()) => {
    const error = await createVertexModel(s, { fetchImpl: google.fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(ChatSetupError);
    return { error: error as ChatSetupError, google };
  };

  it("asks for a key file when none is chosen, without touching the network", async () => {
    const { error, google } = await failure(settings({ keyFile: "" }));
    expect(error.hint).toBe("choose-key-file");
    expect(error.message).toContain("Choose Google Service Account Key File");
    expect(google.calls).toHaveLength(0);
  });

  it("names a key file that cannot be read", async () => {
    const missing = path.join(dir, "gone.json");
    const { error } = await failure(settings({ keyFile: missing }));
    expect(error.hint).toBe("choose-key-file");
    expect(error.message).toContain(missing);
  });

  it("refuses a file that is not JSON or not a service account, and never quotes it", async () => {
    fs.writeFileSync(keyFile, `{"type":"authorized_user","client_secret":"super-secret-value-123"}`);
    const a = await failure(settings());
    expect(a.error.message).toContain("service_account");
    expect(a.error.message).not.toContain("super-secret-value-123");
    fs.writeFileSync(keyFile, "not json at all");
    expect((await failure(settings())).error.message).toContain("not a JSON file");
  });

  it("does not repeat the private key in any message", async () => {
    writeKey({ private_key: "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----\n" });
    const { error } = await failure(settings());
    expect(error.message).not.toContain("bm90IGEga2V5");
  });

  it("refuses a key file that is far too large to be a key", async () => {
    fs.writeFileSync(keyFile, `{"x":"${"a".repeat(70_000)}"}`);
    expect((await failure(settings())).error.message).toContain("too large");
  });

  it("passes on Google's own reason when it rejects the account", async () => {
    const google = fakeGoogle();
    google.behaviour.tokenStatus = 400;
    google.behaviour.tokenError = "Invalid JWT Signature.";
    const { error } = await failure(settings(), google);
    expect(error.hint).toBe("choose-key-file");
    expect(error.message).toContain("Invalid JWT Signature.");
  });

  it("says Google cannot be reached, without blaming the key", async () => {
    const google = fakeGoogle();
    google.behaviour.fail = true;
    const { error } = await failure(settings(), google);
    expect(error.hint).toBeUndefined();
    expect(error.message).toContain("Could not reach Google");
  });

  it("points to the setting when the location or project is not valid", async () => {
    expect((await failure(settings({ location: "not a place" }))).error.hint).toBe("open-settings");
    expect((await failure(settings({ project: "x" }))).error.message).toContain("terax.ai.vertex.project");
  });

  it("notices a key file that disappears between messages", async () => {
    const google = fakeGoogle([{ text: "first" }, { text: "second" }]);
    const model = await createVertexModel(settings(), { fetchImpl: google.fetchImpl });
    const ask = () =>
      runAgent({ model, system: "s", messages: [{ role: "user", content: "hi" }], tools: {}, maxSteps: 2, signal: new AbortController().signal, emit: () => undefined });
    await ask();
    fs.rmSync(keyFile);
    const error = await ask().catch((e) => e);
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.hint).toBe("choose-key-file");
  });
});

describe("key files", () => {
  it("reads a service account file, and expands ~", async () => {
    const account = await readKeyFile(keyFile);
    expect(account).toMatchObject({ clientEmail: "terax@my-proj.iam.gserviceaccount.com", projectId: "my-proj" });
    expect(expandHome("~/keys/a.json", "/home/me")).toBe(path.join("/home/me", "keys/a.json"));
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("/abs/a.json", "/home/me")).toBe("/abs/a.json");
    expect(expandHome("~other/a.json", "/home/me")).toBe("~other/a.json");
  });

  it("reads the file named with a ~ from the home folder", async () => {
    const home = fs.mkdtempSync(path.join(dir, "home-"));
    fs.writeFileSync(path.join(home, "k.json"), fs.readFileSync(keyFile));
    expect((await readKeyFile(path.join(expandHome("~", home), "k.json"))).projectId).toBe("my-proj");
  });
});

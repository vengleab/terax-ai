import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../../shared/chat";
import { WorkspaceGuard } from "./guard";
import { buildTools, summarizeCall, type ToolContext } from "./tools";

let dir: string;
let approvals: ApprovalRequest[];
let answer: boolean;
let readFiles: Set<string>;
let tools: ReturnType<typeof buildTools>;
let terminalText: string;

const sh = () => ({ file: "/bin/sh", args: (c: string) => ["-c", c], env: { PATH: process.env.PATH ?? "" } });

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terax-tools-")));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "hello.txt"), "one\ntwo\nthree\nfour\nfive\n");
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "const a = 1;\nconst b = 2;\n");
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=abc");
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  approvals = [];
  answer = true;
  terminalText = "$ npm test\nFAIL src/app.test.ts\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456";
  readFiles = new Set();
  const ctx: ToolContext = {
    guard: new WorkspaceGuard(() => [dir]),
    approve: async (request) => {
      approvals.push(request);
      return answer;
    },
    readTerminal: async () => terminalText,
    shell: sh,
    commandTimeoutSeconds: () => 10,
    readFiles,
  };
  tools = buildTools(ctx);
});

// biome-ignore lint/suspicious/noExplicitAny: the tool objects are called the way the AI SDK calls them
const call = async (name: string, input: Record<string, unknown>, id = "call-1"): Promise<any> =>
  // biome-ignore lint/suspicious/noExplicitAny: see above
  (tools[name] as any).execute(input, { toolCallId: id, messages: [], abortSignal: undefined });

describe("read_file", () => {
  it("reads a file and says where in the file the text is", async () => {
    const r = await call("read_file", { path: "hello.txt" });
    expect(r).toMatchObject({ start_line: 1, total_lines: 6, truncated: false });
    expect(r.content).toBe("one\ntwo\nthree\nfour\nfive\n");
  });

  it("pages through a file with offset and limit", async () => {
    const r = await call("read_file", { path: "hello.txt", offset: 2, limit: 2 });
    expect(r.content).toBe("two\nthree");
    expect(r).toMatchObject({ start_line: 2, end_line: 3, truncated: true });
  });

  it("refuses secret files, files outside the workspace, binary files and folders", async () => {
    expect((await call("read_file", { path: ".env" })).error).toMatch(/Refused|protected|secret/i);
    expect((await call("read_file", { path: "../outside" })).error).toMatch(/outside the workspace/);
    expect((await call("read_file", { path: "bin.dat" })).error).toMatch(/binary/);
    expect((await call("read_file", { path: "src" })).error).toMatch(/not a file/);
    expect((await call("read_file", { path: "missing.txt" })).error).toMatch(/Could not read/);
  });

  it("never asks the user", async () => {
    await call("read_file", { path: "hello.txt" });
    expect(approvals).toEqual([]);
  });
});

describe("list_directory, glob, grep", () => {
  it("lists folders first", async () => {
    const r = await call("list_directory", { path: "." });
    expect(r.entries[0]).toEqual({ name: "src", type: "dir" });
    expect(r.entries.map((e: { name: string }) => e.name)).toContain("hello.txt");
  });

  it("finds files by pattern, never offering secret ones", async () => {
    expect((await call("glob", { pattern: "**/*.ts" })).matches).toEqual(["src/app.ts"]);
    expect((await call("glob", { pattern: ".env" })).matches).toEqual([]);
  });

  it("searches contents, with line numbers, and skips secrets and binaries", async () => {
    const r = await call("grep", { pattern: "const b" });
    expect(r.matches).toEqual([{ file: "src/app.ts", line: 2, text: "const b = 2;" }]);
    expect((await call("grep", { pattern: "TOKEN" })).matches).toEqual([]);
    expect((await call("grep", { pattern: "CONST", ignore_case: true, glob: "*.ts" })).matches).toHaveLength(2);
  });

  it("explains a bad regular expression", async () => {
    expect((await call("grep", { pattern: "(" })).error).toMatch(/Invalid regular expression/);
  });
});

describe("read_terminal", () => {
  it("returns what the terminal shows, with secrets removed", async () => {
    const r = await call("read_terminal", {});
    expect(r.text).toContain("FAIL src/app.test.ts");
    expect(r.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("write_file", () => {
  it("asks first, showing what will be written, then writes", async () => {
    const r = await call("write_file", { path: "notes/new.txt", content: "hi\n" }, "w1");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: "w1", kind: "write", title: "Create a file", detail: path.join(dir, "notes", "new.txt") });
    expect(approvals[0].diff?.some((l) => l.kind === "add" && l.text === "hi")).toBe(true);
    expect(r).toMatchObject({ created: true, bytes: 3 });
    expect(fs.readFileSync(path.join(dir, "notes", "new.txt"), "utf8")).toBe("hi\n");
  });

  it("writes nothing when the user says no, and tells the model not to retry", async () => {
    answer = false;
    const r = await call("write_file", { path: "no.txt", content: "x" });
    expect(r.denied).toBe(true);
    expect(fs.existsSync(path.join(dir, "no.txt"))).toBe(false);
  });

  it("refuses protected and outside paths before asking", async () => {
    expect((await call("write_file", { path: ".env", content: "x" })).error).toBeTruthy();
    expect((await call("write_file", { path: "../x.txt", content: "x" })).error).toMatch(/outside/);
    expect(approvals).toEqual([]);
  });
});

describe("edit_file", () => {
  it("needs the file to have been read first", async () => {
    expect((await call("edit_file", { path: "src/app.ts", old_string: "a = 1", new_string: "a = 9" })).error).toMatch(/Read .* before editing/);
    expect(approvals).toEqual([]);
  });

  it("asks, shows the change, and applies it", async () => {
    await call("read_file", { path: "src/app.ts" });
    const r = await call("edit_file", { path: "src/app.ts", old_string: "a = 1", new_string: "a = 9" }, "e1");
    expect(approvals[0]).toMatchObject({ id: "e1", kind: "edit" });
    expect(approvals[0].diff).toContainEqual({ kind: "add", text: "const a = 9;" });
    expect(r.replacements).toBe(1);
    expect(fs.readFileSync(path.join(dir, "src", "app.ts"), "utf8")).toBe("const a = 9;\nconst b = 2;\n");
  });

  it("is exact about what it replaces", async () => {
    await call("read_file", { path: "src/app.ts" });
    expect((await call("edit_file", { path: "src/app.ts", old_string: "nope", new_string: "x" })).error).toMatch(/not found/);
    expect((await call("edit_file", { path: "src/app.ts", old_string: "const", new_string: "let" })).error).toMatch(/matches 2 places/);
    const all = await call("edit_file", { path: "src/app.ts", old_string: "const", new_string: "let", replace_all: true });
    expect(all.replacements).toBe(2);
    expect(fs.readFileSync(path.join(dir, "src", "app.ts"), "utf8")).toBe("let a = 1;\nlet b = 2;\n");
  });

  it("changes nothing when denied", async () => {
    await call("read_file", { path: "src/app.ts" });
    answer = false;
    const r = await call("edit_file", { path: "src/app.ts", old_string: "a = 1", new_string: "a = 9" });
    expect(r.denied).toBe(true);
    expect(fs.readFileSync(path.join(dir, "src", "app.ts"), "utf8")).toContain("a = 1");
  });

  it("treats $ patterns in the new text literally", async () => {
    await call("read_file", { path: "src/app.ts" });
    await call("edit_file", { path: "src/app.ts", old_string: "a = 1", new_string: "a = '$&$1'" });
    expect(fs.readFileSync(path.join(dir, "src", "app.ts"), "utf8")).toContain("a = '$&$1';");
  });
});

describe.skipIf(process.platform === "win32")("run_command", () => {
  it("asks first, showing the command and where it runs, then runs it", async () => {
    const r = await call("run_command", { command: "echo ran-it", cwd: "src" }, "c1");
    expect(approvals[0]).toEqual({ id: "c1", kind: "command", title: "Run a command", detail: "echo ran-it", cwd: path.join(dir, "src") });
    expect(r).toMatchObject({ exit_code: 0, stdout: "ran-it\n", cwd: path.join(dir, "src"), timed_out: false });
  });

  it("runs nothing when denied", async () => {
    answer = false;
    const r = await call("run_command", { command: `touch ${path.join(dir, "created-by-command")}` });
    expect(r.denied).toBe(true);
    expect(fs.existsSync(path.join(dir, "created-by-command"))).toBe(false);
  });

  it("refuses dangerous or multi-line commands before asking", async () => {
    expect((await call("run_command", { command: "rm -rf /" })).error).toMatch(/Refused/);
    expect((await call("run_command", { command: "echo a\necho b" })).error).toMatch(/control characters/);
    expect(approvals).toEqual([]);
  });

  it("will not run outside the workspace", async () => {
    expect((await call("run_command", { command: "pwd", cwd: "/" })).error).toMatch(/outside/);
  });

  it("reports failures, timeouts and removes secrets from the output", async () => {
    const failed = await call("run_command", { command: "echo bad >&2; exit 2" });
    expect(failed).toMatchObject({ exit_code: 2, stderr: "bad\n" });
    const timed = await call("run_command", { command: "sleep 20", timeout_seconds: 1 });
    expect(timed.timed_out).toBe(true);
    const leaked = await call("run_command", { command: "echo sk-abcdefghijklmnopqrstuvwxyz123456" });
    expect(leaked.stdout).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("summarizeCall", () => {
  it("says what each call is about", () => {
    expect(summarizeCall("run_command", { command: "npm test" })).toBe("npm test");
    expect(summarizeCall("edit_file", { path: "a.ts" })).toBe("a.ts");
    expect(summarizeCall("list_directory", {})).toBe(".");
    expect(summarizeCall("grep", { pattern: "TODO" })).toBe("TODO");
    expect(summarizeCall("read_terminal", {})).toBe("terminal output");
    expect(summarizeCall("unknown", null)).toBe("");
  });
});

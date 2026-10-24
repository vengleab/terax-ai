import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { redactSensitive } from "../../../src/modules/ai/lib/redact";
import { checkReadable, checkShellCommand } from "../../../src/modules/ai/lib/security";
import type { ApprovalRequest } from "../../shared/chat";
import { previewChange } from "./diff";
import { runCommand } from "./exec";
import type { WorkspaceGuard } from "./guard";
import { MAX_FILES_SCANNED, matchesGlob, walkFiles } from "./walk";

const MAX_READ_BYTES = 5 * 1024 * 1024;
const READ_BYTES_SHOWN = 25 * 1024;
const READ_LINES_DEFAULT = 2000;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 300;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 400;
const COMMAND_OUTPUT_BYTES = 60_000;
const TERMINAL_LINES_DEFAULT = 100;
const TERMINAL_LINES_MAX = 300;

export type ToolContext = {
  guard: WorkspaceGuard;
  /** Asks the person. Resolves true only if they approved this exact action. */
  approve: (request: ApprovalRequest) => Promise<boolean>;
  /** The last lines of the active Terax terminal, as the page shows them. */
  readTerminal: (lines: number) => Promise<string>;
  /** How a command is run: the program, and its arguments for this command line. */
  shell: () => { file: string; args: (command: string) => string[]; env: Record<string, string> };
  commandTimeoutSeconds: () => number;
  /** Files read or written in this chat. An edit needs the file to have been read first. */
  readFiles: Set<string>;
};

const DENIED = { denied: true, error: "The user denied this action. Do not retry it; ask what they would like instead." };

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** A short line saying what a tool call does, for the chat. */
export function summarizeCall(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "run_command":
      return text(o.command);
    case "read_file":
    case "write_file":
    case "edit_file":
      return text(o.path);
    case "list_directory":
      return text(o.path) || ".";
    case "grep":
      return text(o.pattern);
    case "glob":
      return text(o.pattern);
    case "read_terminal":
      return "terminal output";
    default:
      return "";
  }
}

export function buildTools(ctx: ToolContext): ToolSet {
  const refused = (reason: string) => ({ error: reason });

  return {
    read_file: tool({
      description:
        "Read a text file in the workspace. Returns up to 2000 lines or 25 KB from `offset` (1-based line). Use offset and limit to page through large files.",
      inputSchema: z.object({
        path: z.string().describe("File path, relative to the workspace folder or absolute."),
        offset: z.number().int().min(1).optional().describe("First line to read, starting at 1."),
        limit: z.number().int().min(1).max(READ_LINES_DEFAULT).optional().describe("How many lines to read."),
      }),
      execute: async ({ path: input, offset, limit }) => {
        const resolved = await ctx.guard.resolve(input, "read");
        if (!resolved.ok) return refused(resolved.reason);
        try {
          const stat = await fs.stat(resolved.path);
          if (!stat.isFile()) return refused(`${input} is not a file.`);
          if (stat.size > MAX_READ_BYTES) return refused(`${input} is larger than 5 MB.`);
          const buffer = await fs.readFile(resolved.path);
          if (looksBinary(buffer)) return refused(`${input} looks like a binary file.`);
          const lines = buffer.toString("utf8").split("\n");
          const start = (offset ?? 1) - 1;
          const wanted = lines.slice(start, start + (limit ?? READ_LINES_DEFAULT));
          let content = wanted.join("\n");
          let truncated = start + wanted.length < lines.length;
          if (Buffer.byteLength(content) > READ_BYTES_SHOWN) {
            content = Buffer.from(content).subarray(0, READ_BYTES_SHOWN).toString("utf8");
            truncated = true;
          }
          ctx.readFiles.add(resolved.path);
          return {
            path: resolved.path,
            start_line: start + 1,
            end_line: start + content.split("\n").length,
            total_lines: lines.length,
            truncated,
            content,
          };
        } catch (error) {
          return refused(`Could not read ${input}: ${(error as Error).message}`);
        }
      },
    }),

    list_directory: tool({
      description: "List the files and folders in a workspace folder.",
      inputSchema: z.object({ path: z.string().optional().describe("Folder path. Defaults to the workspace folder.") }),
      execute: async ({ path: input }) => {
        const resolved = await ctx.guard.resolve(input ?? ".", "read");
        if (!resolved.ok) return refused(resolved.reason);
        try {
          const entries = await fs.readdir(resolved.path, { withFileTypes: true });
          entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          return {
            path: resolved.path,
            entries: entries.slice(0, MAX_LIST_ENTRIES).map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file",
            })),
            truncated: entries.length > MAX_LIST_ENTRIES,
          };
        } catch (error) {
          return refused(`Could not list ${input ?? "."}: ${(error as Error).message}`);
        }
      },
    }),

    glob: tool({
      description: "Find files by name pattern, for example `**/*.ts` or `package.json`. Skips node_modules, .git and build folders.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern. Without a `/` it matches file names anywhere."),
        path: z.string().optional().describe("Folder to search in. Defaults to the workspace folder."),
      }),
      execute: async ({ pattern, path: input }, { abortSignal }) => {
        const resolved = await ctx.guard.resolve(input ?? ".", "read");
        if (!resolved.ok) return refused(resolved.reason);
        const matches: string[] = [];
        for await (const file of walkFiles(resolved.path, abortSignal)) {
          const relative = path.relative(resolved.path, file);
          if (matchesGlob(pattern, relative) && checkReadable(file).ok) matches.push(relative.split(path.sep).join("/"));
          if (matches.length >= MAX_GLOB_RESULTS) break;
        }
        return { path: resolved.path, matches, truncated: matches.length >= MAX_GLOB_RESULTS };
      },
    }),

    grep: tool({
      description: "Search file contents with a regular expression. Returns matching lines with file and line number.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regular expression."),
        path: z.string().optional().describe("Folder to search in. Defaults to the workspace folder."),
        glob: z.string().optional().describe("Only search files matching this glob, for example `**/*.rs`."),
        ignore_case: z.boolean().optional(),
      }),
      execute: async ({ pattern, path: input, glob, ignore_case }, { abortSignal }) => {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, ignore_case ? "i" : "");
        } catch (error) {
          return refused(`Invalid regular expression: ${(error as Error).message}`);
        }
        const resolved = await ctx.guard.resolve(input ?? ".", "read");
        if (!resolved.ok) return refused(resolved.reason);
        const matches: { file: string; line: number; text: string }[] = [];
        let scanned = 0;
        for await (const file of walkFiles(resolved.path, abortSignal)) {
          const relative = path.relative(resolved.path, file).split(path.sep).join("/");
          if (glob && !matchesGlob(glob, relative)) continue;
          if (!checkReadable(file).ok) continue;
          let buffer: Buffer;
          try {
            if ((await fs.stat(file)).size > MAX_GREP_FILE_BYTES) continue;
            buffer = await fs.readFile(file);
          } catch {
            continue;
          }
          if (looksBinary(buffer)) continue;
          scanned++;
          const lines = buffer.toString("utf8").split("\n");
          for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
            if (regex.test(lines[i])) matches.push({ file: relative, line: i + 1, text: clip(lines[i]) });
          }
          if (matches.length >= MAX_GREP_MATCHES) break;
        }
        return { matches, files_searched: scanned, truncated: matches.length >= MAX_GREP_MATCHES || scanned >= MAX_FILES_SCANNED };
      },
    }),

    read_terminal: tool({
      description:
        "Read the last lines shown in the user's active Terax terminal. Use it when they refer to an error, the last command or what is on screen.",
      inputSchema: z.object({ lines: z.number().int().min(1).max(TERMINAL_LINES_MAX).optional() }),
      execute: async ({ lines }) => {
        const text = await ctx.readTerminal(lines ?? TERMINAL_LINES_DEFAULT);
        return { text: redactSensitive(text) };
      },
    }),

    write_file: tool({
      description:
        "Create a file or replace its whole content. Asks the user first. For a change to an existing file use edit_file instead.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path: input, content }, { toolCallId }) => {
        const resolved = await ctx.guard.resolve(input, "write");
        if (!resolved.ok) return refused(resolved.reason);
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return refused("The content is larger than 1 MB.");
        let before = "";
        let existed = true;
        try {
          before = await fs.readFile(resolved.path, "utf8");
        } catch {
          existed = false;
        }
        const { lines, truncated } = previewChange(before, content);
        const approved = await ctx.approve({
          id: toolCallId,
          kind: "write",
          title: existed ? "Replace a file" : "Create a file",
          detail: resolved.path,
          diff: lines,
          diffTruncated: truncated,
        });
        if (!approved) return DENIED;
        try {
          await fs.mkdir(path.dirname(resolved.path), { recursive: true });
          await fs.writeFile(resolved.path, content, "utf8");
          ctx.readFiles.add(resolved.path);
          return { path: resolved.path, created: !existed, bytes: Buffer.byteLength(content) };
        } catch (error) {
          return refused(`Could not write ${input}: ${(error as Error).message}`);
        }
      },
    }),

    edit_file: tool({
      description:
        "Replace text in an existing file. `old_string` must match exactly once unless replace_all is true. The file must have been read with read_file first. Asks the user first.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path: input, old_string, new_string, replace_all }, { toolCallId }) => {
        const resolved = await ctx.guard.resolve(input, "write");
        if (!resolved.ok) return refused(resolved.reason);
        if (!ctx.readFiles.has(resolved.path)) return refused(`Read ${input} with read_file before editing it.`);
        let before: string;
        try {
          before = await fs.readFile(resolved.path, "utf8");
        } catch (error) {
          return refused(`Could not read ${input}: ${(error as Error).message}`);
        }
        const count = before.split(old_string).length - 1;
        if (count === 0) return refused("old_string was not found in the file. Read the file again and copy the text exactly.");
        if (count > 1 && !replace_all) {
          return refused(`old_string matches ${count} places. Add more surrounding text to make it unique, or set replace_all.`);
        }
        const after = replace_all ? before.split(old_string).join(new_string) : before.replace(old_string, () => new_string);
        if (Buffer.byteLength(after) > MAX_WRITE_BYTES * 5) return refused("The result would be larger than 5 MB.");
        const { lines, truncated } = previewChange(before, after);
        const approved = await ctx.approve({
          id: toolCallId,
          kind: "edit",
          title: "Edit a file",
          detail: resolved.path,
          diff: lines,
          diffTruncated: truncated,
        });
        if (!approved) return DENIED;
        try {
          await fs.writeFile(resolved.path, after, "utf8");
          return { path: resolved.path, replacements: replace_all ? count : 1 };
        } catch (error) {
          return refused(`Could not write ${input}: ${(error as Error).message}`);
        }
      },
    }),

    run_command: tool({
      description:
        "Run one shell command and return its output. Asks the user first. Use it for tests, builds, git and other short commands; never for programs that wait for input or run forever.",
      inputSchema: z.object({
        command: z.string().describe("A single-line command."),
        cwd: z.string().optional().describe("Folder to run in. Defaults to the workspace folder."),
        timeout_seconds: z.number().int().min(1).max(600).optional(),
      }),
      execute: async ({ command, cwd, timeout_seconds }, { toolCallId, abortSignal }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return refused(safety.reason);
        const folder = await ctx.guard.resolve(cwd ?? ".", "read");
        if (!folder.ok) return refused(folder.reason);
        const approved = await ctx.approve({ id: toolCallId, kind: "command", title: "Run a command", detail: command, cwd: folder.path });
        if (!approved) return DENIED;
        const shell = ctx.shell();
        const result = await runCommand({
          file: shell.file,
          args: shell.args(command),
          cwd: folder.path,
          env: shell.env,
          timeoutMs: Math.min(timeout_seconds ?? ctx.commandTimeoutSeconds(), 600) * 1000,
          maxBytes: COMMAND_OUTPUT_BYTES,
          signal: abortSignal,
        });
        return {
          command,
          cwd: folder.path,
          exit_code: result.exitCode,
          stdout: redactSensitive(result.stdout),
          stderr: redactSensitive(result.stderr),
          timed_out: result.timedOut,
          cancelled: result.aborted,
          truncated: result.truncated,
        };
      },
    }),
  };
}

/**
 * What the AI chat sends between the extension host (where the agent runs) and the page (where it is
 * shown). The host keeps the conversation as a list of these events, so a page that reloads or is
 * opened later can be brought up to date by replaying them.
 */

export type ApprovalKind = "command" | "write" | "edit";

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

export type ApprovalRequest = {
  /** The tool call this decision is for. */
  id: string;
  kind: ApprovalKind;
  /** One line: "Run a command", "Edit src/app.ts". */
  title: string;
  /** What will run or be written: the command line, or the file path. */
  detail: string;
  /** Where a command runs. */
  cwd?: string;
  /** A preview of a file change. Capped, so a huge file cannot flood the page. */
  diff?: DiffLine[];
  diffTruncated?: boolean;
};

export type ChatErrorHint = "set-key" | "select-model" | "open-settings" | "choose-key-file";

export type ChatEvent =
  | { type: "user"; id: string; text: string }
  | { type: "assistant-start"; id: string }
  | { type: "text"; id: string; delta: string }
  | { type: "reasoning"; id: string; delta: string }
  | { type: "tool-call"; id: string; name: string; summary: string; input: unknown }
  | { type: "tool-result"; id: string; output: unknown; isError: boolean; denied?: boolean }
  | { type: "approval"; request: ApprovalRequest }
  | { type: "approval-done"; id: string; approved: boolean }
  | { type: "error"; message: string; hint?: ChatErrorHint }
  | { type: "done"; inputTokens?: number; outputTokens?: number }
  | { type: "status"; running: boolean }
  | { type: "reset" };

/** Commands the page may ask the host to run. Nothing else is accepted from the page. */
export const PAGE_COMMANDS = ["terax.ai.setApiKey", "terax.ai.selectModel", "terax.ai.openSettings", "terax.ai.chooseKeyFile"] as const;
export type PageCommand = (typeof PAGE_COMMANDS)[number];

export function isPageCommand(value: unknown): value is PageCommand {
  return typeof value === "string" && (PAGE_COMMANDS as readonly string[]).includes(value);
}

/** Keeps stored replay events small: runs of text for the same block are joined. */
export function appendEvent(events: ChatEvent[], event: ChatEvent): void {
  const last = events[events.length - 1];
  if ((event.type === "text" || event.type === "reasoning") && last && last.type === event.type && last.id === event.id) {
    last.delta += event.delta;
    return;
  }
  if (event.type === "reset") {
    events.length = 0;
    return;
  }
  events.push(event);
}

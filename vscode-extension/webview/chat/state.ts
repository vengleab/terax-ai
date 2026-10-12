import type { ApprovalRequest, ChatErrorHint, ChatEvent } from "../../shared/chat";

export type ToolStatus = "running" | "waiting" | "done" | "failed" | "denied" | "stopped";

export type TextPart = { kind: "text" | "reasoning"; id: string; text: string };
export type ToolPart = {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  status: ToolStatus;
  output?: unknown;
};
export type Part = TextPart | ToolPart;

export type Message =
  | { role: "user"; id: string; text: string }
  | { role: "assistant"; id: string; parts: Part[]; usage?: { input?: number; output?: number } }
  | { role: "error"; id: string; text: string; hint?: ChatErrorHint };

/** What changed, so the page redraws only that. */
export type Change = { messages: string[]; approvals: boolean; status: boolean; reset: boolean };

const none = (): Change => ({ messages: [], approvals: false, status: false, reset: false });

/**
 * The conversation as the page shows it, built from the host's events. A page that starts late is
 * brought up to date by feeding it the whole list again, so the same events always give the same view.
 */
export class ChatModel {
  messages: Message[] = [];
  approvals: ApprovalRequest[] = [];
  running = false;
  model = "";
  private errors = 0;

  clear(): void {
    this.messages = [];
    this.approvals = [];
    this.running = false;
    this.errors = 0;
  }

  /** Replaces everything with a replayed conversation. */
  load(events: ChatEvent[], running: boolean, model: string): void {
    this.clear();
    for (const event of events) this.apply(event);
    this.running = running;
    this.model = model;
    if (!running) this.settleUnfinished();
  }

  private lastAssistant(): (Message & { role: "assistant" }) | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant") return m;
      if (m.role === "user") return undefined;
    }
    return undefined;
  }

  private findTool(id: string): { message: Message & { role: "assistant" }; part: ToolPart } | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "assistant") continue;
      const part = m.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === id);
      if (part) return { message: m, part };
    }
    return undefined;
  }

  /** Tool calls that never got a result, because the turn was stopped or ended in an error. */
  private settleUnfinished(): Change {
    const change = none();
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts) {
        if (part.kind === "tool" && (part.status === "running" || part.status === "waiting")) {
          part.status = "stopped";
          change.messages.push(m.id);
        }
      }
    }
    return change;
  }

  apply(event: ChatEvent): Change {
    const change = none();
    switch (event.type) {
      case "reset":
        this.clear();
        change.reset = true;
        break;
      case "user":
        this.messages.push({ role: "user", id: event.id, text: event.text });
        change.messages.push(event.id);
        break;
      case "assistant-start":
        this.messages.push({ role: "assistant", id: event.id, parts: [] });
        change.messages.push(event.id);
        break;
      case "text":
      case "reasoning": {
        const message = this.lastAssistant();
        if (!message) break;
        const existing = message.parts.find((p): p is TextPart => p.kind === event.type && p.id === event.id);
        if (existing) existing.text += event.delta;
        else message.parts.push({ kind: event.type, id: event.id, text: event.delta });
        change.messages.push(message.id);
        break;
      }
      case "tool-call": {
        const message = this.lastAssistant();
        if (!message) break;
        if (!message.parts.some((p) => p.kind === "tool" && p.id === event.id)) {
          message.parts.push({ kind: "tool", id: event.id, name: event.name, summary: event.summary, status: "running" });
        }
        change.messages.push(message.id);
        break;
      }
      case "approval": {
        if (!this.approvals.some((a) => a.id === event.request.id)) this.approvals.push(event.request);
        change.approvals = true;
        const found = this.findTool(event.request.id);
        if (found) {
          found.part.status = "waiting";
          change.messages.push(found.message.id);
        }
        break;
      }
      case "approval-done": {
        this.approvals = this.approvals.filter((a) => a.id !== event.id);
        change.approvals = true;
        const found = this.findTool(event.id);
        if (found) {
          found.part.status = event.approved ? "running" : "denied";
          change.messages.push(found.message.id);
        }
        break;
      }
      case "tool-result": {
        const found = this.findTool(event.id);
        if (found) {
          found.part.output = event.output;
          found.part.status = event.denied ? "denied" : event.isError ? "failed" : "done";
          change.messages.push(found.message.id);
        }
        break;
      }
      case "error": {
        const id = `e${++this.errors}`;
        this.messages.push({ role: "error", id, text: event.message, hint: event.hint });
        change.messages.push(id);
        break;
      }
      case "done": {
        const message = this.lastAssistant();
        if (message && (event.inputTokens !== undefined || event.outputTokens !== undefined)) {
          message.usage = { input: event.inputTokens, output: event.outputTokens };
          change.messages.push(message.id);
        }
        break;
      }
      case "status":
        this.running = event.running;
        change.status = true;
        if (!event.running) {
          const settled = this.settleUnfinished();
          change.messages.push(...settled.messages);
        }
        break;
    }
    return change;
  }
}

export type ResultSummary = { headline: string; body?: string };

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line, and the longer text behind it, saying what a tool did. */
export function summarizeResult(name: string, output: unknown): ResultSummary {
  const o = asRecord(output);
  if (typeof o.error === "string") return { headline: o.error };
  switch (name) {
    case "run_command": {
      const out = [str(o.stdout), str(o.stderr)].filter((s) => s.trim()).join("\n");
      const code = num(o.exit_code);
      const how = o.timed_out === true ? "timed out" : o.cancelled === true ? "cancelled" : code === 0 ? "exit 0" : code === undefined || code === null ? "ended" : `exit ${code}`;
      return { headline: how, body: out || undefined };
    }
    case "read_file":
      return { headline: `lines ${num(o.start_line) ?? "?"}–${num(o.end_line) ?? "?"} of ${num(o.total_lines) ?? "?"}` };
    case "list_directory": {
      const entries = Array.isArray(o.entries) ? o.entries : [];
      return { headline: plural(entries.length, "entry", "entries"), body: entries.map((e) => `${asRecord(e).type === "dir" ? "📁" : "  "} ${str(asRecord(e).name)}`).join("\n") || undefined };
    }
    case "glob": {
      const matches = Array.isArray(o.matches) ? o.matches.map(String) : [];
      return { headline: plural(matches.length, "match", "matches"), body: matches.join("\n") || undefined };
    }
    case "grep": {
      const matches = Array.isArray(o.matches) ? o.matches : [];
      return {
        headline: plural(matches.length, "match", "matches"),
        body: matches.map((m) => `${str(asRecord(m).file)}:${num(asRecord(m).line) ?? "?"}  ${str(asRecord(m).text)}`).join("\n") || undefined,
      };
    }
    case "read_terminal":
      return { headline: "read the terminal", body: str(o.text) || undefined };
    case "write_file":
      return { headline: o.created === true ? "created" : "replaced" };
    case "edit_file": {
      const n = num(o.replacements) ?? 1;
      return { headline: plural(n, "replacement") };
    }
    default:
      return { headline: "done" };
  }
}

/** The title a tool call gets in the chat. */
export function toolTitle(name: string): string {
  switch (name) {
    case "run_command":
      return "Run command";
    case "read_file":
      return "Read file";
    case "list_directory":
      return "List folder";
    case "glob":
      return "Find files";
    case "grep":
      return "Search";
    case "read_terminal":
      return "Read terminal";
    case "write_file":
      return "Write file";
    case "edit_file":
      return "Edit file";
    default:
      return name;
  }
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

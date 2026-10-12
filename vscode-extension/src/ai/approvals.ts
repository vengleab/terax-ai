import type { ApprovalRequest } from "../../shared/chat";

type Pending = { request: ApprovalRequest; resolve: (approved: boolean) => void };

/**
 * Holds actions that wait for the person's answer. The agent's tool awaits `request`, the page shows a
 * popup, and the answer arrives through `answer`. Anything left unanswered when a chat is stopped or
 * reset counts as a refusal, so nothing can run later on a decision nobody made.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly shown: (request: ApprovalRequest) => void,
    private readonly settled: (id: string, approved: boolean) => void,
  ) {}

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      if (this.pending.has(request.id)) {
        // The same call asked twice: the earlier question stands, the later one is refused.
        resolve(false);
        return;
      }
      this.pending.set(request.id, { request, resolve });
      signal?.addEventListener("abort", () => this.answer(request.id, false), { once: true });
      this.shown(request);
    });
  }

  /** Records an answer. Returns false for an id that is not waiting (late, repeated or made up). */
  answer(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this.settled(id, approved);
    entry.resolve(approved);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, false);
  }

  get waiting(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }
}

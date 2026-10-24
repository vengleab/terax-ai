import { FLOW_HIGH_WATER, FLOW_LOW_WATER } from "../shared/messages";

export type FlowHooks = {
  pause(id: number): void;
  resume(id: number): void;
};

/**
 * Keeps the shell from running ahead of the page. Output the page has not yet acknowledged is
 * counted; past the high-water mark the shell is paused (it then blocks on its own terminal buffer),
 * and it resumes once the page has caught up to the low-water mark.
 */
export class FlowControl {
  private readonly unacked = new Map<number, number>();
  private readonly paused = new Set<number>();

  constructor(
    private readonly hooks: FlowHooks,
    private readonly high = FLOW_HIGH_WATER,
    private readonly low = FLOW_LOW_WATER,
  ) {}

  sent(id: number, bytes: number): void {
    const total = (this.unacked.get(id) ?? 0) + bytes;
    this.unacked.set(id, total);
    if (total > this.high && !this.paused.has(id)) {
      this.paused.add(id);
      this.hooks.pause(id);
    }
  }

  acknowledged(id: number, bytes: number): void {
    if (!this.unacked.has(id)) return;
    const total = Math.max(0, (this.unacked.get(id) ?? 0) - bytes);
    this.unacked.set(id, total);
    if (total <= this.low && this.paused.delete(id)) this.hooks.resume(id);
  }

  forget(id: number): void {
    this.unacked.delete(id);
    this.paused.delete(id);
  }

  clear(): void {
    this.unacked.clear();
    this.paused.clear();
  }

  isPaused(id: number): boolean {
    return this.paused.has(id);
  }
}

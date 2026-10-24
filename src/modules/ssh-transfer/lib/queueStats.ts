import type {
  ConflictInfo,
  SkippedItem,
  TransferRequest,
  TransferSummary,
  WireEvent,
} from "../types";
import { formatBytes } from "./format";

export type JobStatus =
  | "starting"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "cancelled";

export type TransferJob = {
  key: string;
  id: number | null;
  title: string;
  from: string;
  to: string;
  request: TransferRequest;
  status: JobStatus;
  files: { done: number; total: number };
  bytes: { done: number; total: number };
  speed: number;
  current: string[];
  skipped: SkippedItem[];
  conflict: { conflictId: number; info: ConflictInfo } | null;
  summary: TransferSummary | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export function isActive(job: TransferJob): boolean {
  return job.status === "starting" || job.status === "running" || job.status === "waiting";
}

export function newJob(
  key: string,
  request: TransferRequest,
  labels: { title: string; from: string; to: string },
  now: number,
): TransferJob {
  return {
    key,
    id: null,
    ...labels,
    request,
    status: "starting",
    files: { done: 0, total: 0 },
    bytes: { done: 0, total: 0 },
    speed: 0,
    current: [],
    skipped: [],
    conflict: null,
    summary: null,
    error: null,
    startedAt: now,
    finishedAt: null,
  };
}

/** Folds one backend event into the job. Pure, so the queue UI is easy to test. */
export function applyWireEvent(job: TransferJob, event: WireEvent, now: number): TransferJob {
  if (!isActive(job)) return job;
  switch (event.kind) {
    case "planned":
      return {
        ...job,
        status: "running",
        files: { done: 0, total: event.files },
        bytes: { done: 0, total: event.bytes },
        skipped: event.skipped,
      };
    case "progress":
      return {
        ...job,
        status: job.conflict ? "waiting" : "running",
        files: { done: event.filesDone, total: event.filesTotal },
        bytes: { done: event.bytesDone, total: event.bytesTotal },
        speed: event.bytesPerSec,
        current: event.current,
      };
    case "conflict":
      return {
        ...job,
        status: "waiting",
        conflict: { conflictId: event.conflictId, info: event.info },
      };
    case "finished": {
      const { summary } = event;
      const failed = summary.errors.length > 0 && summary.filesDone === 0 && summary.moved === 0;
      return {
        ...job,
        status: summary.cancelled ? "cancelled" : failed ? "error" : "done",
        summary,
        conflict: null,
        speed: 0,
        current: [],
        files: { done: summary.filesDone, total: Math.max(job.files.total, summary.filesDone) },
        bytes: { done: summary.bytesDone, total: Math.max(job.bytes.total, summary.bytesDone) },
        error: failed ? summary.errors[0]?.message ?? "The transfer failed" : null,
        finishedAt: now,
      };
    }
    case "failed":
      return {
        ...job,
        status: "error",
        error: event.error.message,
        conflict: null,
        speed: 0,
        current: [],
        finishedAt: now,
      };
  }
}

/** The conflict was answered, so the job is moving again. */
export function clearConflict(job: TransferJob): TransferJob {
  return job.conflict ? { ...job, conflict: null, status: "running" } : job;
}

export function percent(job: TransferJob): number {
  if (job.status === "done") return 100;
  if (job.bytes.total > 0) {
    return Math.min(100, Math.floor((job.bytes.done / job.bytes.total) * 100));
  }
  if (job.files.total > 0) {
    return Math.min(100, Math.floor((job.files.done / job.files.total) * 100));
  }
  return 0;
}

export function etaSeconds(job: TransferJob): number | null {
  if (job.status !== "running" || job.speed <= 0) return null;
  const remaining = job.bytes.total - job.bytes.done;
  return remaining > 0 ? remaining / job.speed : null;
}

export function describeOutcome(job: TransferJob): string {
  const summary = job.summary;
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "error") return job.error ?? "Failed";
  if (!summary) return "";
  const parts: string[] = [];
  if (summary.filesDone > 0) {
    parts.push(`${summary.filesDone} ${summary.filesDone === 1 ? "file" : "files"} (${formatBytes(summary.bytesDone)})`);
  }
  if (summary.moved > 0) parts.push(`${summary.moved} moved`);
  if (summary.filesSkipped > 0) parts.push(`${summary.filesSkipped} skipped`);
  if (summary.skipped.length > 0) parts.push(`${summary.skipped.length} not copied`);
  if (summary.errors.length > 0) {
    parts.push(`${summary.errors.length} ${summary.errors.length === 1 ? "error" : "errors"}`);
  }
  return parts.length > 0 ? parts.join(", ") : "Nothing to do";
}

export function summarizeQueue(jobs: TransferJob[]): {
  active: number;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
} {
  let active = 0;
  let bytesDone = 0;
  let bytesTotal = 0;
  let speed = 0;
  for (const job of jobs) {
    if (!isActive(job)) continue;
    active += 1;
    bytesDone += job.bytes.done;
    bytesTotal += job.bytes.total;
    speed += job.speed;
  }
  return { active, bytesDone, bytesTotal, speed };
}

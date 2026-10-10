import { toast } from "sonner";
import { create } from "zustand";
import { sshApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  applyWireEvent,
  clearConflict,
  describeOutcome,
  isActive,
  newJob,
  type TransferJob,
} from "../lib/queueStats";
import type { ConflictDecision, TransferRequest, WireEvent } from "../types";

type Labels = { title: string; from: string; to: string };

type TransferState = {
  jobs: TransferJob[];
  finishedTick: number;
  start: (request: TransferRequest, labels: Labels) => string;
  cancel: (key: string) => Promise<void>;
  resolveConflict: (key: string, decision: ConflictDecision, applyToAll: boolean) => Promise<void>;
  retry: (key: string) => void;
  dismiss: (key: string) => void;
  clearFinished: () => void;
};

const MAX_JOBS = 100;
let seq = 0;
const ids = new Map<string, Promise<number>>();

function patchJob(
  set: (fn: (s: TransferState) => Partial<TransferState>) => void,
  key: string,
  update: (job: TransferJob) => TransferJob,
) {
  set((s) => ({ jobs: s.jobs.map((j) => (j.key === key ? update(j) : j)) }));
}

export const useTransferStore = create<TransferState>((set, get) => ({
  jobs: [],
  finishedTick: 0,

  start: (request, labels) => {
    seq += 1;
    const key = `job-${seq}`;
    set((s) => ({ jobs: [newJob(key, request, labels, Date.now()), ...s.jobs].slice(0, MAX_JOBS) }));

    const onEvent = (event: WireEvent) => {
      patchJob(set, key, (job) => applyWireEvent(job, event, Date.now()));
      if (event.kind !== "finished" && event.kind !== "failed") return;
      set((s) => ({ finishedTick: s.finishedTick + 1 }));
      const job = get().jobs.find((j) => j.key === key);
      if (!job) return;
      if (job.status === "error") {
        toast.error(`${job.title} failed`, { description: job.error ?? undefined });
      } else if (job.status === "done" && (job.summary?.errors.length ?? 0) > 0) {
        toast.warning(`${job.title} finished with errors`, { description: describeOutcome(job) });
      }
    };

    const started = sshApi.transferStart(request, onEvent);
    ids.set(key, started);
    started.catch((error) => {
      patchJob(set, key, (job) =>
        isActive(job)
          ? { ...job, status: "error", error: errorMessage(error), finishedAt: Date.now() }
          : job,
      );
      toast.error(`${labels.title} could not start`, { description: errorMessage(error) });
    });
    void started.then((id) => patchJob(set, key, (job) => ({ ...job, id })), () => undefined);
    return key;
  },

  cancel: async (key) => {
    const id = await ids.get(key)?.catch(() => null);
    if (id == null) return;
    try {
      await sshApi.transferCancel(id);
    } catch {
      // already finished
    }
  },

  resolveConflict: async (key, decision, applyToAll) => {
    const job = get().jobs.find((j) => j.key === key);
    const conflict = job?.conflict;
    const id = await ids.get(key)?.catch(() => null);
    if (!conflict || id == null) return;
    patchJob(set, key, clearConflict);
    try {
      await sshApi.transferResolve(id, conflict.conflictId, decision, applyToAll);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  },

  retry: (key) => {
    const job = get().jobs.find((j) => j.key === key);
    if (!job || isActive(job)) return;
    get().start({ ...job.request, resume: true }, { title: job.title, from: job.from, to: job.to });
  },

  dismiss: (key) => {
    ids.delete(key);
    set((s) => ({ jobs: s.jobs.filter((j) => j.key !== key || isActive(j)) }));
  },

  clearFinished: () => set((s) => ({ jobs: s.jobs.filter(isActive) })),
}));

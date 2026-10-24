import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { formatBytes, formatDuration, formatSpeed } from "../lib/format";
import {
  describeOutcome,
  etaSeconds,
  isActive,
  percent,
  summarizeQueue,
  type TransferJob,
} from "../lib/queueStats";
import { useTransferStore } from "../store/transferStore";

function statusLabel(job: TransferJob): string {
  switch (job.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Copying";
    case "waiting":
      return "Needs your answer";
    case "done":
      return (job.summary?.errors.length ?? 0) > 0 ? "Done with errors" : "Done";
    case "cancelled":
      return "Cancelled";
    case "error":
      return "Failed";
  }
}

function tone(job: TransferJob): "default" | "secondary" | "destructive" | "outline" {
  if (job.status === "error") return "destructive";
  if (job.status === "waiting") return "outline";
  if (isActive(job)) return "secondary";
  return "outline";
}

function JobRow({ job }: { job: TransferJob }) {
  const [open, setOpen] = useState(false);
  const cancel = useTransferStore((s) => s.cancel);
  const retry = useTransferStore((s) => s.retry);
  const dismiss = useTransferStore((s) => s.dismiss);
  const active = isActive(job);
  const eta = etaSeconds(job);
  const detailsAvailable = !!job.summary && (job.summary.errors.length > 0 || job.summary.skipped.length > 0);
  const canRetry = !active && (job.status === "error" || job.status === "cancelled" || (job.summary?.errors.length ?? 0) > 0);

  return (
    <li className="border-b border-border/50 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={open ? "Hide details" : "Show details"}
          disabled={!detailsAvailable}
          onClick={() => setOpen(!open)}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-30"
        >
          <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} strokeWidth={2} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{job.title}</span>
            <Badge variant={tone(job)} className="h-4 shrink-0 px-1.5 text-[10px]">
              {statusLabel(job)}
            </Badge>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {job.from} to {job.to}
          </div>
        </div>
        {active ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => void cancel(job.key)}>
            Cancel
          </Button>
        ) : (
          <>
            {canRetry ? (
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Retry" onClick={() => retry(job.key)}>
                <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => dismiss(job.key)}>
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
            </Button>
          </>
        )}
      </div>

      {active ? (
        <div className="mt-1.5 pl-6">
          <Progress value={percent(job)} className="h-1.5" />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] tabular-nums text-muted-foreground">
            <span>
              {job.files.total > 0 ? `${job.files.done} / ${job.files.total} files` : "Preparing"}
            </span>
            {job.bytes.total > 0 ? (
              <span>
                {formatBytes(job.bytes.done)} / {formatBytes(job.bytes.total)}
              </span>
            ) : null}
            {job.speed > 0 ? <span>{formatSpeed(job.speed)}</span> : null}
            {eta != null ? <span>{formatDuration(eta)} left</span> : null}
            {job.current[0] ? <span className="min-w-0 truncate">{job.current[0]}</span> : null}
          </div>
        </div>
      ) : (
        <div className={cn("mt-0.5 pl-6 text-[11px]", job.status === "error" ? "text-destructive" : "text-muted-foreground")}>
          {describeOutcome(job)}
        </div>
      )}

      {open && job.summary ? (
        <div className="mt-1.5 space-y-1 pl-6 text-[11px]">
          {job.summary.errors.slice(0, 20).map((error) => (
            <div key={`${error.path}:${error.message}`} className="text-destructive">
              <span className="font-medium">{error.path || "Transfer"}</span>: {error.message}
            </div>
          ))}
          {job.summary.skipped.slice(0, 20).map((item) => (
            <div key={item.path} className="text-muted-foreground">
              <span className="font-medium">{item.path}</span>: {item.reason}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function TransferQueue() {
  const jobs = useTransferStore((s) => s.jobs);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const [collapsed, setCollapsed] = useState(false);
  if (jobs.length === 0) return null;
  const totals = summarizeQueue(jobs);
  const hasFinished = jobs.some((j) => !isActive(j));

  return (
    <section aria-label="Transfers" className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-border/70 bg-card/40">
      <header className="flex h-8 shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-xs font-medium text-foreground"
          aria-expanded={!collapsed}
        >
          <HugeiconsIcon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} size={12} strokeWidth={2} />
          Transfers
        </button>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {totals.active > 0
            ? `${totals.active} active${totals.speed > 0 ? `, ${formatSpeed(totals.speed)}` : ""}`
            : `${jobs.length} finished`}
        </span>
        <span className="flex-1" />
        {hasFinished ? (
          <Button type="button" variant="ghost" size="xs" onClick={clearFinished}>
            Clear finished
          </Button>
        ) : null}
      </header>
      {collapsed ? null : <ul className="min-h-0 flex-1 overflow-y-auto">{jobs.map((job) => <JobRow key={job.key} job={job} />)}</ul>}
    </section>
  );
}

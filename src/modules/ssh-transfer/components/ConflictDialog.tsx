import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { formatBytes, formatMtime } from "../lib/format";
import { baseName } from "../lib/pathOps";
import { useTransferStore } from "../store/transferStore";
import type { ConflictDecision, ConflictInfo } from "../types";

function newerNote(info: ConflictInfo): string {
  if (info.srcMtime == null || info.dstMtime == null) return "";
  if (info.srcMtime === info.dstMtime) return "Both were modified at the same time.";
  return info.srcMtime > info.dstMtime ? "The new file is more recent." : "The existing file is more recent.";
}

function Side({ title, size, mtime }: { title: string; size: number; mtime: number | null }) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-0.5 text-sm tabular-nums">{formatBytes(size)}</div>
      <div className="text-xs text-muted-foreground">{mtime == null ? "Unknown date" : formatMtime(mtime)}</div>
    </div>
  );
}

/** Asks what to do when a file already exists at the destination. One question at a time. */
export function ConflictDialog() {
  const job = useTransferStore((s) => s.jobs.find((j) => j.conflict));
  const resolve = useTransferStore((s) => s.resolveConflict);
  const [all, setAll] = useState(false);
  const conflict = job?.conflict;
  if (!job || !conflict) return null;
  const { info } = conflict;

  const answer = (decision: ConflictDecision) => {
    void resolve(job.key, decision, all);
    setAll(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && answer("cancel")}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{baseName(info.dstPath)} already exists</DialogTitle>
          <DialogDescription className="break-all">{info.dstPath}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Side title="Existing" size={info.dstSize} mtime={info.dstMtime} />
          <Side title="New" size={info.srcSize} mtime={info.srcMtime} />
        </div>
        <p className="text-xs text-muted-foreground">{newerNote(info)}</p>
        <div className="flex items-center gap-2">
          <Checkbox id="sshx-conflict-all" checked={all} onCheckedChange={(v) => setAll(v === true)} />
          <Label htmlFor="sshx-conflict-all" className="text-xs font-normal">
            Do this for all remaining conflicts in this transfer
          </Label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={() => answer("cancel")}>
            Cancel transfer
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => answer("skip")}>
              Skip
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => answer("rename")}>
              Keep both
            </Button>
            <Button type="button" size="sm" onClick={() => answer("overwrite")}>
              Replace
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Delete02Icon, ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { useUiStore } from "../store/uiStore";
import type { KnownHostRow } from "../types";

function hostLabel(row: KnownHostRow): string {
  if (row.hashed) return "hashed host";
  return row.hosts.length > 0 ? row.hosts.join(", ") : "unknown host";
}

export function KnownHostsDialog() {
  const close = useUiStore((s) => s.close);
  const [rows, setRows] = useState<KnownHostRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<KnownHostRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await sshApi.knownHosts());
      setError(null);
    } catch (caught) {
      setRows(null);
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    const row = pending;
    if (!row) return;
    setPending(null);
    setBusy(true);
    try {
      await sshApi.knownHostRemove(row.line);
      toast.success("Host key removed");
    } catch (caught) {
      toast.error("Could not remove the host key", {
        description: errorMessage(caught),
      });
    }
    // Line numbers shift after a removal, so the list is always reloaded first.
    await load();
    setBusy(false);
  };

  const locked = busy || loading;

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent className="gap-4 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="pr-8 text-[14px]">Known hosts</DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed">
              These are the host keys Terax trusts for SSH File Transfer.
              Removing one makes Terax ask you to verify that server again.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-32">
            {rows === null && loading ? (
              <div className="flex h-32 items-center justify-center gap-2 text-[12px] text-muted-foreground">
                <Spinner className="size-3.5" />
                Loading known hosts
              </div>
            ) : error ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
                <p
                  role="alert"
                  className="max-w-md text-[12px] text-destructive"
                >
                  {error}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void load()}
                  disabled={loading}
                >
                  Try again
                </Button>
              </div>
            ) : rows && rows.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 text-center">
                <HugeiconsIcon
                  icon={ShieldKeyIcon}
                  size={18}
                  strokeWidth={1.5}
                  className="text-muted-foreground"
                />
                <p className="text-[12px] font-medium">No trusted hosts yet</p>
                <p className="max-w-xs text-[11px] text-muted-foreground">
                  A server appears here the first time you trust its key.
                </p>
              </div>
            ) : rows ? (
              <div className="max-h-[50vh] overflow-auto rounded-lg border border-border/60">
                <table className="w-full table-fixed text-[12px]">
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[16%]" />
                    <col />
                    <col className="w-[16%]" />
                    <col className="w-10" />
                  </colgroup>
                  <thead>
                    <tr className="text-left text-[10.5px] text-muted-foreground">
                      <Th>Host</Th>
                      <Th>Algorithm</Th>
                      <Th>Fingerprint</Th>
                      <Th>Comment</Th>
                      <th className="sticky top-0 border-b border-border/60 bg-popover">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.line}
                        className="border-b border-border/40 last:border-b-0 hover:bg-muted/30"
                      >
                        <td className="px-2.5 py-1.5 align-middle">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={
                                row.hashed
                                  ? "truncate text-muted-foreground italic"
                                  : "truncate font-mono"
                              }
                              title={hostLabel(row)}
                            >
                              {hostLabel(row)}
                            </span>
                            {row.marker ? (
                              <Badge
                                variant={
                                  row.marker === "revoked"
                                    ? "destructive"
                                    : "secondary"
                                }
                                className="h-4 px-1.5 text-[10px]"
                              >
                                {row.marker === "revoked" ? "revoked" : "CA"}
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-2.5 py-1.5 align-middle">
                          <span
                            className="block truncate font-mono text-muted-foreground"
                            title={row.algorithm}
                          >
                            {row.algorithm}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 align-middle">
                          <span
                            className="block select-text truncate font-mono text-[11px]"
                            title={row.fingerprint}
                          >
                            {row.fingerprint}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 align-middle">
                          <span
                            className="block truncate text-muted-foreground"
                            title={row.comment ?? undefined}
                          >
                            {row.comment}
                          </span>
                        </td>
                        <td className="px-1 py-1 text-right align-middle">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={locked}
                            onClick={() => setPending(row)}
                            aria-label={`Remove host key for ${hostLabel(row)}`}
                            title="Remove"
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              size={13}
                              strokeWidth={1.75}
                            />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this host key?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? `${pending.hashed ? "This hashed host" : hostLabel(pending)} will be forgotten. `
                : ""}
              Next connection will ask you to verify the server again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void remove()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="sticky top-0 border-b border-border/60 bg-popover px-2.5 py-1.5 font-medium">
      {children}
    </th>
  );
}

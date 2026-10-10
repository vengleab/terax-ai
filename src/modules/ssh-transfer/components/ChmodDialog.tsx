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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatMode, modeToOctal, parseOctalMode } from "../lib/format";
import { type DialogRequest, useUiStore } from "../store/uiStore";

type Props = { request: Extract<DialogRequest, { kind: "chmod" }> };

const CLASSES = [
  { label: "Owner", shift: 6 },
  { label: "Group", shift: 3 },
  { label: "Others", shift: 0 },
] as const;

const ACCESS = [
  { label: "Read", bit: 0o4 },
  { label: "Write", bit: 0o2 },
  { label: "Execute", bit: 0o1 },
] as const;

const FALLBACK_MODE = 0o644;

export function ChmodDialog({ request }: Props) {
  const close = useUiStore((s) => s.close);
  const known = request.mode !== null;
  const initial = known ? (request.mode as number) & 0o7777 : FALLBACK_MODE;
  const [mode, setMode] = useState(initial);
  const [text, setText] = useState(modeToOctal(initial));
  const [busy, setBusy] = useState(false);
  const octalId = useId();

  const parsed = parseOctalMode(text);

  const onText = (value: string) => {
    setText(value);
    const next = parseOctalMode(value);
    if (next !== null) setMode(next);
  };

  const toggle = (mask: number) => {
    const next = mode ^ mask;
    setMode(next);
    setText(modeToOctal(next));
  };

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    if (parsed === null || busy) return;
    setBusy(true);
    try {
      await sshApi.fsChmod(request.endpoint, request.path, parsed);
      request.onDone?.();
      close();
    } catch (error) {
      toast.error("Could not change permissions", {
        description: errorMessage(error),
      });
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent className="gap-4 sm:max-w-sm">
        <form onSubmit={apply} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="pr-8 text-[14px] leading-snug break-all">
              Permissions for {request.name}
            </DialogTitle>
            <DialogDescription
              className="truncate font-mono text-[11px]"
              title={request.path}
            >
              {request.path}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-[4.5rem_repeat(3,minmax(0,1fr))] items-center gap-x-2 gap-y-2.5 text-[12px]">
            <span />
            {ACCESS.map((access) => (
              <span
                key={access.label}
                className="text-center text-[11px] font-medium text-muted-foreground"
              >
                {access.label}
              </span>
            ))}
            {CLASSES.map((cls) => (
              <Row
                key={cls.label}
                label={cls.label}
                mode={mode}
                shift={cls.shift}
                disabled={busy}
                onToggle={toggle}
              />
            ))}
          </div>

          <div className="flex items-end gap-3">
            <div className="flex w-24 flex-col gap-1">
              <Label
                htmlFor={octalId}
                className="text-[11px] font-medium text-muted-foreground"
              >
                Octal
              </Label>
              <Input
                id={octalId}
                value={text}
                onChange={(event) => onText(event.target.value)}
                inputMode="numeric"
                maxLength={4}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={parsed === null || undefined}
                disabled={busy}
                className="h-8 font-mono text-[12px] md:text-[12px]"
              />
            </div>
            <code
              className="pb-1.5 font-mono text-[13px] tracking-wide"
              title="Symbolic permissions"
            >
              {formatMode(mode)}
            </code>
          </div>

          <div className="flex flex-col gap-1 text-[11px] leading-relaxed text-muted-foreground">
            {parsed === null ? (
              <p role="alert" className="text-destructive">
                Enter 3 or 4 octal digits, for example 644 or 1777.
              </p>
            ) : null}
            {known ? null : <p>The current permissions could not be read.</p>}
            <p>
              Setuid, setgid and sticky bits are preserved only if you type all
              four digits.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={parsed === null || busy}>
              {busy ? <Spinner className="size-3.5" /> : null}
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  mode,
  shift,
  disabled,
  onToggle,
}: {
  label: string;
  mode: number;
  shift: number;
  disabled: boolean;
  onToggle: (mask: number) => void;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      {ACCESS.map((access) => {
        const mask = access.bit << shift;
        return (
          <span key={access.label} className="flex justify-center">
            <Checkbox
              checked={(mode & mask) !== 0}
              onCheckedChange={() => onToggle(mask)}
              aria-label={`${label} ${access.label.toLowerCase()}`}
              disabled={disabled}
            />
          </span>
        );
      })}
    </>
  );
}

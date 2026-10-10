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
import { cn } from "@/lib/utils";
import { Alert02Icon, ShieldKeyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, useCallback, useId, useRef, useState } from "react";
import {
  type HostKeyPrompt,
  type SecretAnswer,
  type SecretPrompt,
  usePromptStore,
} from "../store/promptStore";
import type { KnownKey } from "../types";

export function PromptHost() {
  const prompt = usePromptStore((s) => s.queue[0]);
  if (!prompt) return null;
  return prompt.kind === "hostKey" ? (
    <HostKeyDialog key={prompt.id} prompt={prompt} />
  ) : (
    <SecretDialog key={prompt.id} prompt={prompt} />
  );
}

function useSettle<T>(resolve: (value: T) => void) {
  const settled = useRef(false);
  return useCallback(
    (value: T) => {
      if (settled.current) return;
      settled.current = true;
      resolve(value);
      usePromptStore.getState().answerFirst();
    },
    [resolve],
  );
}

function endpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function KeyLine({
  algorithm,
  fingerprint,
  className,
}: {
  algorithm: string;
  fingerprint: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[10.5px] text-muted-foreground">{algorithm}</span>
      <code className="select-text break-all font-mono text-[11.5px] leading-relaxed">
        {fingerprint}
      </code>
    </div>
  );
}

function KeyList({ keys }: { keys: KnownKey[] }) {
  return (
    <div className="flex flex-col gap-2">
      {keys.map((key) => (
        <KeyLine
          key={`${key.line}:${key.fingerprint}`}
          algorithm={key.algorithm}
          fingerprint={key.fingerprint}
        />
      ))}
    </div>
  );
}

function HostKeyDialog({ prompt }: { prompt: HostKeyPrompt }) {
  const { data, changed } = prompt;
  const revoked = data.revoked === true;
  const danger = changed || revoked;
  const settle = useSettle(prompt.resolve);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const otherKeys = data.otherKeys ?? [];
  const recorded = data.recorded ?? [];
  const where = endpoint(data.host, data.port);

  const title = revoked
    ? "Host key revoked"
    : changed
      ? "Host key has changed"
      : "Trust this server?";

  return (
    <Dialog open onOpenChange={(open) => !open && settle(false)}>
      <DialogContent
        className={cn(
          "gap-4 sm:max-w-md",
          danger && "ring-2 ring-destructive/40",
        )}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle
            className={cn(
              "flex items-center gap-2 pr-8 text-[14px]",
              danger && "text-destructive",
            )}
          >
            <HugeiconsIcon
              icon={danger ? Alert02Icon : ShieldKeyIcon}
              size={16}
              strokeWidth={1.75}
              className="shrink-0"
            />
            {title}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            {revoked
              ? `The key that ${where} presented is marked as revoked, so Terax will not connect. Do not trust this server until its administrator confirms the key.`
              : changed
                ? "This server presented a different key than the one Terax recorded. That can mean someone is intercepting your connection, so only replace the key if you know it was changed on purpose."
                : `Terax has not connected to ${where} before. If you can, compare the fingerprint below with one from the server's administrator.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3 text-[12px]">
            <span className="text-muted-foreground">Server</span>
            <code className="select-text font-mono">{where}</code>
          </div>

          {changed && recorded.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Recorded fingerprint{recorded.length === 1 ? "" : "s"}
              </span>
              <KeyList keys={recorded} />
            </div>
          ) : null}

          <div
            className={cn(
              "flex flex-col gap-1.5 rounded-lg border px-2.5 py-2",
              danger
                ? "border-destructive/40 bg-destructive/10"
                : "border-border/60 bg-muted/30",
            )}
          >
            <span className="text-[11px] font-medium text-muted-foreground">
              {changed ? "Presented now" : "Fingerprint"}
            </span>
            <KeyLine
              algorithm={data.presented.algorithm}
              fingerprint={data.presented.fingerprint}
            />
          </div>

          {!changed && !revoked && otherKeys.length > 0 ? (
            <div
              role="alert"
              className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2"
            >
              <span className="text-[12px] font-medium text-amber-700 dark:text-amber-400">
                Other key types are already on file for this host
              </span>
              <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                A server normally keeps presenting the same key type. If you did
                not expect a new one, cancel and check with the administrator.
              </span>
              <KeyList keys={otherKeys} />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => settle(false)}
          >
            {revoked ? "Close" : "Cancel"}
          </Button>
          {revoked ? null : (
            <Button
              type="button"
              size="sm"
              variant={changed ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {changed ? "Replace key and connect" : "Trust and connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ prompt }: { prompt: SecretPrompt }) {
  const settle = useSettle<SecretAnswer | null>(prompt.resolve);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const inputId = useId();
  const rememberId = useId();
  const isPassword = prompt.secret === "password";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.length === 0) return;
    settle({ value, remember });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && settle(null)}>
      <DialogContent
        className="gap-4 sm:max-w-sm"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="pr-8 text-[14px] leading-snug break-words">
              {isPassword
                ? `Password for ${prompt.profileName}`
                : `Passphrase for ${prompt.profileName}'s key`}
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              Enter it to continue connecting.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId} className="sr-only">
              {isPassword ? "Password" : "Passphrase"}
            </Label>
            <Input
              id={inputId}
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={prompt.invalid || undefined}
              placeholder={isPassword ? "Password" : "Passphrase"}
              className="h-8 text-[12px] md:text-[12px]"
            />
            {prompt.invalid ? (
              <p role="alert" className="text-[11.5px] text-destructive">
                That was not accepted. Try again.
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id={rememberId}
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <Label
              htmlFor={rememberId}
              className="text-[12px] font-normal text-muted-foreground"
            >
              Remember in the system keychain
            </Label>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => settle(null)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={value.length === 0}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

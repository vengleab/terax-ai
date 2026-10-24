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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  Edit02Icon,
  NetworkIcon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { errorMessage, isCancelled } from "../lib/errors";
import { formatBytes } from "../lib/format";
import {
  changeForwardType,
  describeForward,
  emptyForwardForm,
  FORWARD_TYPE_LABELS,
  type ForwardFormValues,
  type ForwardType,
  forwardToForm,
  isLoopbackHost,
  validateForwardForm,
} from "../lib/forwardForm";
import { useProfilesStore } from "../store/profilesStore";
import { type DialogRequest, useUiStore } from "../store/uiStore";
import type { ForwardSpec, SshProfile, TunnelStatus } from "../types";
import { Field } from "./ProfileDialog";

type Props = { request: Extract<DialogRequest, { kind: "tunnels" }> };

type View = { kind: "list" } | { kind: "form"; editing: ForwardSpec | null };

const POLL_MS = 2000;
const INPUT = "h-8 text-[12px] md:text-[12px]";
const NUMBER_INPUT = `${INPUT} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;
const TYPE_BADGE: Record<ForwardType, string> = {
  local: "Local",
  remote: "Remote",
  dynamic: "SOCKS",
};

export function TunnelsDialog({ request }: Props) {
  const close = useUiStore((s) => s.close);
  const profiles = useProfilesStore((s) => s.profiles);
  const connections = useProfilesStore((s) => s.connections);
  const [choice, setChoice] = useState<string | null>(
    request.profileId ?? null,
  );
  const [forwards, setForwards] = useState<ForwardSpec[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, TunnelStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<View>({ kind: "list" });
  const [deleting, setDeleting] = useState<ForwardSpec | null>(null);
  const alive = useRef(true);
  const lastStats = useRef("");

  const activeId = profiles.some((p) => p.id === choice)
    ? choice
    : (profiles[0]?.id ?? null);
  const profile = profiles.find((p) => p.id === activeId);
  const connected = activeId !== null && connections[activeId] !== undefined;

  const loadForwards = useCallback(async () => {
    try {
      const list = await sshApi.forwards();
      if (!alive.current) return;
      setForwards(list);
      setLoadError(null);
    } catch (error) {
      if (alive.current) setLoadError(errorMessage(error));
    }
  }, []);

  const refreshStats = useCallback(async (): Promise<TunnelStatus[] | null> => {
    try {
      const list = await sshApi.tunnels();
      if (!alive.current) return list;
      const key = JSON.stringify(list);
      if (key !== lastStats.current) {
        lastStats.current = key;
        setStats(Object.fromEntries(list.map((t) => [t.id, t])));
      }
      return list;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadForwards();
    void refreshStats();
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      void refreshStats().finally(() => {
        inFlight = false;
      });
    }, POLL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [loadForwards, refreshStats]);

  const setBusyFor = (id: string, value: boolean) =>
    setBusy((b) => ({ ...b, [id]: value }));

  const start = async (spec: ForwardSpec) => {
    setBusyFor(spec.id, true);
    try {
      if (!useProfilesStore.getState().connections[spec.profileId]) {
        await useProfilesStore.getState().connect(spec.profileId);
        // Connecting also starts autostart forwards, so this one may already be running.
        const running = await refreshStats();
        if (running?.some((t) => t.id === spec.id)) return;
      }
      await sshApi.forwardStart(spec.id);
      await refreshStats();
    } catch (error) {
      if (!isCancelled(error)) {
        toast.error(`Could not start "${spec.name}"`, {
          description: errorMessage(error),
        });
      }
    } finally {
      if (alive.current) setBusyFor(spec.id, false);
    }
  };

  const stop = async (spec: ForwardSpec) => {
    setBusyFor(spec.id, true);
    try {
      await sshApi.forwardStop(spec.id);
      await refreshStats();
    } catch (error) {
      toast.error(`Could not stop "${spec.name}"`, {
        description: errorMessage(error),
      });
    } finally {
      if (alive.current) setBusyFor(spec.id, false);
    }
  };

  const setAutostart = async (spec: ForwardSpec, autostart: boolean) => {
    setBusyFor(spec.id, true);
    try {
      const saved = await sshApi.forwardSave({ ...spec, autostart });
      if (alive.current) {
        setForwards((list) =>
          list ? list.map((f) => (f.id === saved.id ? saved : f)) : list,
        );
      }
    } catch (error) {
      toast.error("Could not change autostart", {
        description: errorMessage(error),
      });
    } finally {
      if (alive.current) setBusyFor(spec.id, false);
    }
  };

  const confirmDelete = async () => {
    const spec = deleting;
    if (!spec) return;
    setDeleting(null);
    try {
      await sshApi.forwardRemove(spec.id);
    } catch (error) {
      toast.error(`Could not delete "${spec.name}"`, {
        description: errorMessage(error),
      });
    }
    await Promise.all([loadForwards(), refreshStats()]);
  };

  const visible = useMemo(
    () => (forwards ?? []).filter((f) => f.profileId === activeId),
    [forwards, activeId],
  );

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent className="gap-4 sm:max-w-2xl">
          {view.kind === "form" && profile ? (
            <ForwardFormView
              key={view.editing?.id ?? "new"}
              profile={profile}
              editing={view.editing}
              running={
                view.editing ? stats[view.editing.id] !== undefined : false
              }
              onBack={() => setView({ kind: "list" })}
              onSaved={() => {
                void loadForwards();
                setView({ kind: "list" });
              }}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8 text-[14px]">
                  Port forwarding
                </DialogTitle>
                <DialogDescription className="text-[12px] leading-relaxed">
                  Forward ports through an SSH server. Forwards listen on this
                  machine only, unless you expose them.
                </DialogDescription>
              </DialogHeader>

              {profiles.length === 0 ? (
                <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 px-4 text-center">
                  <HugeiconsIcon
                    icon={NetworkIcon}
                    size={18}
                    strokeWidth={1.5}
                    className="text-muted-foreground"
                  />
                  <p className="text-[12px] font-medium">No servers yet</p>
                  <p className="max-w-xs text-[11px] text-muted-foreground">
                    Add a server first, then create port forwards for it.
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      useUiStore.getState().open({ kind: "profile" })
                    }
                  >
                    Add server
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Server" className="min-w-48 flex-1">
                      {(p) => (
                        <Select
                          value={activeId ?? undefined}
                          onValueChange={setChoice}
                        >
                          <SelectTrigger
                            {...p}
                            size="sm"
                            className="h-8 w-full text-[12px]"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {profiles.map((item) => (
                              <SelectItem
                                key={item.id}
                                value={item.id}
                                className="text-[12px]"
                              >
                                <span>{item.name}</span>
                                <span className="text-muted-foreground">
                                  {item.user}@{item.host}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </Field>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8"
                      onClick={() => setView({ kind: "form", editing: null })}
                    >
                      <HugeiconsIcon
                        icon={Add01Icon}
                        size={13}
                        strokeWidth={1.75}
                      />
                      New forward
                    </Button>
                  </div>

                  <p className="-mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        connected ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                    {connected
                      ? "Connected"
                      : "Not connected. Starting a forward connects first."}
                  </p>

                  <div className="-mx-2 max-h-[50vh] min-h-28 overflow-y-auto px-2 py-0.5">
                    {forwards === null && !loadError ? (
                      <div className="flex h-28 items-center justify-center gap-2 text-[12px] text-muted-foreground">
                        <Spinner className="size-3.5" />
                        Loading forwards
                      </div>
                    ) : loadError ? (
                      <div className="flex h-28 flex-col items-center justify-center gap-2 text-center">
                        <p
                          role="alert"
                          className="max-w-md text-[12px] text-destructive"
                        >
                          {loadError}
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => void loadForwards()}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : visible.length === 0 ? (
                      <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/60 px-4 text-center">
                        <p className="text-[12px] font-medium">
                          No forwards for this server
                        </p>
                        <p className="max-w-xs text-[11px] text-muted-foreground">
                          Create one to reach a remote service from this
                          machine, or the other way around.
                        </p>
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {visible.map((spec) => (
                          <ForwardRow
                            key={spec.id}
                            spec={spec}
                            status={stats[spec.id]}
                            busy={busy[spec.id] === true}
                            onStart={() => void start(spec)}
                            onStop={() => void stop(spec)}
                            onEdit={() =>
                              setView({ kind: "form", editing: spec })
                            }
                            onDelete={() => setDeleting(spec)}
                            onAutostart={(value) =>
                              void setAutostart(spec, value)
                            }
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={close}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this forward?</AlertDialogTitle>
            <AlertDialogDescription>
              {`"${deleting?.name ?? ""}" will be stopped if it is running, and removed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ForwardRow({
  spec,
  status,
  busy,
  onStart,
  onStop,
  onEdit,
  onDelete,
  onAutostart,
}: {
  spec: ForwardSpec;
  status: TunnelStatus | undefined;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAutostart: (value: boolean) => void;
}) {
  const autostartId = useId();
  const running = status !== undefined;
  const description = describeForward(spec);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          busy
            ? "animate-pulse bg-amber-500"
            : running
              ? "bg-emerald-500"
              : "bg-muted-foreground/40",
        )}
      />
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium">
            {spec.name}
          </span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {TYPE_BADGE[spec.kind]}
          </Badge>
          {spec.expose ? (
            <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
              exposed
            </Badge>
          ) : null}
          <span className="sr-only">{running ? "Running" : "Stopped"}</span>
        </div>
        <code
          className="select-text truncate font-mono text-[11.5px] text-muted-foreground"
          title={description}
        >
          {description}
        </code>
        {status ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {`Port ${status.boundPort} · ${status.activeConnections} active · ${formatBytes(status.bytesIn)} in · ${formatBytes(status.bytesOut)} out`}
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div
          className="flex items-center gap-1.5"
          title="Start this forward when the server connects"
        >
          <Switch
            id={autostartId}
            size="sm"
            checked={spec.autostart}
            disabled={busy}
            onCheckedChange={onAutostart}
          />
          <Label
            htmlFor={autostartId}
            className="text-[11px] font-normal text-muted-foreground"
          >
            Autostart
          </Label>
        </div>
        <Button
          type="button"
          size="xs"
          variant={running ? "outline" : "default"}
          disabled={busy}
          onClick={running ? onStop : onStart}
          className="w-16"
        >
          {busy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon
              icon={running ? StopIcon : PlayIcon}
              size={11}
              strokeWidth={2}
            />
          )}
          {running ? "Stop" : "Start"}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={onEdit}
          aria-label={`Edit ${spec.name}`}
          title="Edit"
        >
          <HugeiconsIcon icon={Edit02Icon} size={13} strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${spec.name}`}
          title="Delete"
        >
          <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
        </Button>
      </div>
    </li>
  );
}

function ForwardFormView({
  profile,
  editing,
  running,
  onBack,
  onSaved,
}: {
  profile: SshProfile;
  editing: ForwardSpec | null;
  running: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<ForwardFormValues>(() =>
    editing ? forwardToForm(editing) : emptyForwardForm(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exposeId = useId();

  const result = useMemo(
    () =>
      validateForwardForm(values, {
        profileId: profile.id,
        id: editing?.id,
        autostart: editing?.autostart,
      }),
    [values, profile.id, editing],
  );
  const errors = submitted && !result.ok ? result.errors : {};

  const patch = (next: Partial<ForwardFormValues>) =>
    setValues((v) => ({ ...v, ...next }));

  const remote = values.type === "remote";
  const showExpose =
    !remote && values.host.trim() !== "" && !isLoopbackHost(values.host);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!result.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sshApi.forwardSave(result.value);
      toast.success(editing ? "Forward updated" : "Forward created");
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <div className="flex items-center gap-1.5 pr-8">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={onBack}
            aria-label="Back to forwards"
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
          <DialogTitle className="text-[14px]">
            {editing ? "Edit forward" : "New forward"}
          </DialogTitle>
        </div>
        <DialogDescription className="text-[12px] leading-relaxed">
          {`On ${profile.name}. `}
          {running
            ? "This forward is running, so changes apply the next time it starts."
            : ""}
        </DialogDescription>
      </DialogHeader>

      <fieldset
        disabled={busy}
        className="m-0 flex flex-col gap-3 border-0 p-0"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Name" error={errors.name}>
            {(p) => (
              <Input
                {...p}
                value={values.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Postgres"
                className={INPUT}
                autoFocus
              />
            )}
          </Field>
          <Field label="Type">
            {(p) => (
              <Select
                value={values.type}
                onValueChange={(value) =>
                  setValues((v) => changeForwardType(v, value as ForwardType))
                }
              >
                <SelectTrigger
                  {...p}
                  size="sm"
                  className="h-8 w-full text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FORWARD_TYPE_LABELS) as ForwardType[]).map(
                    (type) => (
                      <SelectItem
                        key={type}
                        value={type}
                        className="text-[12px]"
                      >
                        {FORWARD_TYPE_LABELS[type]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
          <Field
            label={remote ? "Bind host (on the server)" : "Listen host"}
            error={errors.host}
          >
            {(p) => (
              <Input
                {...p}
                value={values.host}
                onChange={(e) => patch({ host: e.target.value })}
                spellCheck={false}
                autoCapitalize="off"
                className={cn(INPUT, "font-mono")}
              />
            )}
          </Field>
          <Field
            label={remote ? "Bind port" : "Listen port"}
            error={errors.port}
            hint={remote ? undefined : "0 picks a free port"}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={65535}
                value={values.port}
                onChange={(e) => patch({ port: e.target.value })}
                className={NUMBER_INPUT}
              />
            )}
          </Field>
        </div>

        {values.type !== "dynamic" ? (
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <Field
              label={
                remote
                  ? "Destination host (from this machine)"
                  : "Destination host (from the server)"
              }
              error={errors.destHost}
            >
              {(p) => (
                <Input
                  {...p}
                  value={values.destHost}
                  onChange={(e) => patch({ destHost: e.target.value })}
                  placeholder={remote ? "localhost" : "db.internal"}
                  spellCheck={false}
                  autoCapitalize="off"
                  className={cn(INPUT, "font-mono")}
                />
              )}
            </Field>
            <Field label="Destination port" error={errors.destPort}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={65535}
                  value={values.destPort}
                  onChange={(e) => patch({ destPort: e.target.value })}
                  className={NUMBER_INPUT}
                />
              )}
            </Field>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Point a browser or tool at this SOCKS5 proxy to send its traffic
            through the server.
          </p>
        )}

        {showExpose ? (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={exposeId} className="text-[12px] font-medium">
                Expose to my network
              </Label>
              <span className="text-[10.5px] leading-snug text-muted-foreground">
                Anyone who can reach this machine on that address can use this
                forward.
              </span>
              {errors.expose ? (
                <span role="alert" className="text-[10.5px] text-destructive">
                  {errors.expose}
                </span>
              ) : null}
            </div>
            <Switch
              id={exposeId}
              size="sm"
              checked={values.expose}
              onCheckedChange={(expose) => patch({ expose })}
            />
          </div>
        ) : null}
      </fieldset>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-destructive"
        >
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onBack}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? <Spinner className="size-3.5" /> : null}
          {editing ? "Save changes" : "Create forward"}
        </Button>
      </DialogFooter>
    </form>
  );
}

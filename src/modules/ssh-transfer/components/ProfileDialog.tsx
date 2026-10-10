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
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { errorMessage, isCancelled } from "../lib/errors";
import {
  type AuthKind,
  emptyProfileForm,
  isJumpHostForOthers,
  jumpHostCandidates,
  PROFILE_COLORS,
  type ProfileFormValues,
  profileToForm,
  validateProfileForm,
} from "../lib/profileForm";
import { clearSecret, getSecret, setSecret } from "../lib/secrets";
import { useProfilesStore } from "../store/profilesStore";
import { type DialogRequest, useUiStore } from "../store/uiStore";
import type { KeyInfo, SshProfile } from "../types";

type Props = { request: Extract<DialogRequest, { kind: "profile" }> };

type SecretField = "password" | "passphrase";

const NONE = "__none__";
const INPUT = "h-8 text-[12px] md:text-[12px]";
const NUMBER_INPUT = `${INPUT} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

type FieldControlProps = {
  id: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
};

export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Label
        htmlFor={id}
        className="text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </Label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": note ? noteId : undefined,
      })}
      {note ? (
        <p
          id={noteId}
          role={error ? "alert" : undefined}
          className={cn(
            "text-[10.5px] leading-snug",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

async function connectAndReport(profile: SshProfile) {
  try {
    await useProfilesStore.getState().connect(profile.id);
    toast.success(`Connected to ${profile.name}`);
  } catch (error) {
    if (isCancelled(error)) return;
    toast.error(`Could not connect to ${profile.name}`, {
      description: errorMessage(error),
    });
  }
}

export function ProfileDialog({ request }: Props) {
  const [initial] = useState<SshProfile | null>(() =>
    request.profileId
      ? (useProfilesStore
          .getState()
          .profiles.find((p) => p.id === request.profileId) ?? null)
      : null,
  );
  if (request.profileId && !initial) return <MissingProfile />;
  return <ProfileForm initial={initial} />;
}

function MissingProfile() {
  const close = useUiStore((s) => s.close);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="gap-4 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="pr-8 text-[14px]">
            Server not found
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            This server no longer exists. It may have been deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProfileForm({ initial }: { initial: SshProfile | null }) {
  const close = useUiStore((s) => s.close);
  const profiles = useProfilesStore((s) => s.profiles);
  const [values, setValues] = useState<ProfileFormValues>(() =>
    initial ? profileToForm(initial) : emptyProfileForm(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "connect" | null>(null);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [stored, setStored] = useState<Record<SecretField, boolean | null>>({
    password: null,
    passphrase: null,
  });
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saved = useRef<SshProfile | null>(initial);

  const selfId = initial?.id;
  const result = useMemo(
    () => validateProfileForm(values, { selfId }),
    [values, selfId],
  );
  const errors = submitted && !result.ok ? result.errors : {};
  const busy = pending !== null;

  const secretField: SecretField | null =
    values.authKind === "password"
      ? "password"
      : values.authKind === "keyFile"
        ? "passphrase"
        : null;
  const hasStored = secretField !== null && stored[secretField] === true;

  const candidates = useMemo(
    () => jumpHostCandidates(profiles, selfId),
    [profiles, selfId],
  );
  const usedAsJump = selfId ? isJumpHostForOthers(profiles, selfId) : false;
  const orphanJump =
    values.jumpHost && !candidates.some((c) => c.id === values.jumpHost)
      ? profiles.find((p) => p.id === values.jumpHost)
      : undefined;

  useEffect(() => {
    if (!selfId || !secretField || stored[secretField] !== null) return;
    let alive = true;
    void getSecret(selfId, secretField).then((value) => {
      if (alive) setStored((s) => ({ ...s, [secretField]: value !== null }));
    });
    return () => {
      alive = false;
    };
  }, [selfId, secretField, stored]);

  const wantsKeys = values.authKind === "keyFile";
  useEffect(() => {
    if (!wantsKeys || keys !== null) return;
    let alive = true;
    sshApi
      .keys()
      .then((list) => alive && setKeys(list))
      .catch(() => alive && setKeys([]));
    return () => {
      alive = false;
    };
  }, [wantsKeys, keys]);

  const patch = (next: Partial<ProfileFormValues>) =>
    setValues((v) => ({ ...v, ...next }));

  const persist = async (andConnect: boolean) => {
    setSubmitted(true);
    if (!result.ok || busy) return;
    const input = result.value;
    setPending(andConnect ? "connect" : "save");
    setFormError(null);

    let profile: SshProfile;
    try {
      profile = await useProfilesStore
        .getState()
        .save({ ...(saved.current ?? {}), ...input });
      saved.current = profile;
    } catch (error) {
      setFormError(errorMessage(error));
      setPending(null);
      return;
    }

    try {
      if (input.auth.kind === "password" && password) {
        await setSecret(profile.id, "password", password);
      }
      if (input.auth.kind === "keyFile" && passphrase) {
        await setSecret(profile.id, "passphrase", passphrase);
      }
    } catch (error) {
      setFormError(
        `The server was saved, but its secret could not be stored: ${errorMessage(error)}`,
      );
      setPending(null);
      return;
    }

    close();
    if (andConnect) void connectAndReport(profile);
  };

  const clearStored = async () => {
    if (!selfId || !secretField) return;
    await clearSecret(selfId, secretField);
    setStored((s) => ({ ...s, [secretField]: false }));
    toast.success(
      secretField === "password"
        ? "Stored password removed"
        : "Stored passphrase removed",
    );
  };

  const deleteProfile = async () => {
    if (!selfId) return;
    try {
      await useProfilesStore.getState().remove(selfId);
      toast.success("Server deleted");
      close();
    } catch (error) {
      setConfirmDelete(false);
      setFormError(errorMessage(error));
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && !busy && close()}>
        <DialogContent className="gap-4 sm:max-w-lg">
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void persist(false);
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle className="pr-8 text-[14px]">
                {initial ? "Edit server" : "Add server"}
              </DialogTitle>
              <DialogDescription className="text-[12px] leading-relaxed">
                Passwords and passphrases are kept in the system keychain, never
                in the server profile.
              </DialogDescription>
            </DialogHeader>

            <div className="-mx-2 flex max-h-[calc(100vh-17rem)] flex-col gap-3 overflow-y-auto px-2 py-0.5">
              <Field label="Name" error={errors.name}>
                {(p) => (
                  <Input
                    {...p}
                    value={values.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="Production"
                    className={INPUT}
                    autoFocus={!initial}
                  />
                )}
              </Field>

              <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
                <Field label="Host" error={errors.host}>
                  {(p) => (
                    <Input
                      {...p}
                      value={values.host}
                      onChange={(e) => patch({ host: e.target.value })}
                      placeholder="example.com"
                      spellCheck={false}
                      autoCapitalize="off"
                      className={cn(INPUT, "font-mono")}
                    />
                  )}
                </Field>
                <Field label="Port" error={errors.port}>
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={1}
                      max={65535}
                      value={values.port}
                      onChange={(e) => patch({ port: e.target.value })}
                      className={NUMBER_INPUT}
                    />
                  )}
                </Field>
              </div>

              <Field label="User" error={errors.user}>
                {(p) => (
                  <Input
                    {...p}
                    value={values.user}
                    onChange={(e) => patch({ user: e.target.value })}
                    placeholder="deploy"
                    spellCheck={false}
                    autoCapitalize="off"
                    className={cn(INPUT, "font-mono")}
                  />
                )}
              </Field>

              <Field label="Authentication">
                {(p) => (
                  <Select
                    value={values.authKind}
                    onValueChange={(v) => patch({ authKind: v as AuthKind })}
                  >
                    <SelectTrigger
                      {...p}
                      size="sm"
                      className="h-8 w-full text-[12px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="agent" className="text-[12px]">
                        SSH agent
                      </SelectItem>
                      <SelectItem value="keyFile" className="text-[12px]">
                        Key file
                      </SelectItem>
                      <SelectItem value="password" className="text-[12px]">
                        Password
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>

              {values.authKind === "agent" ? (
                <p className="-mt-1 text-[10.5px] text-muted-foreground">
                  Uses the keys loaded in your running SSH agent.
                </p>
              ) : null}

              {values.authKind === "keyFile" ? (
                <>
                  <Field label="Key file" error={errors.keyPath}>
                    {(p) => (
                      <Input
                        {...p}
                        value={values.keyPath}
                        onChange={(e) => patch({ keyPath: e.target.value })}
                        placeholder="~/.ssh/id_ed25519"
                        spellCheck={false}
                        autoCapitalize="off"
                        className={cn(INPUT, "font-mono")}
                      />
                    )}
                  </Field>
                  {keys && keys.length > 0 ? (
                    <div className="-mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[10.5px] text-muted-foreground">
                        Your keys
                      </span>
                      {keys.map((key) => (
                        <Button
                          key={key.name}
                          type="button"
                          size="xs"
                          variant={
                            values.keyPath.trim() === key.path
                              ? "secondary"
                              : "outline"
                          }
                          className="h-5 px-2 font-mono text-[10.5px]"
                          title={`${key.algorithm} ${key.path}`}
                          onClick={() => patch({ keyPath: key.path })}
                        >
                          {key.name}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <SecretInput
                    label="Key passphrase (stored in the keychain)"
                    value={passphrase}
                    onChange={setPassphrase}
                    stored={hasStored}
                    storedNoun="passphrase"
                    onClear={() => void clearStored()}
                  />
                </>
              ) : null}

              {values.authKind === "password" ? (
                <SecretInput
                  label="Password (stored in the keychain)"
                  value={password}
                  onChange={setPassword}
                  stored={hasStored}
                  storedNoun="password"
                  onClear={() => void clearStored()}
                />
              ) : null}

              <Field
                label="Jump host"
                error={errors.jumpHost}
                hint={
                  usedAsJump
                    ? "Other servers connect through this one, so it cannot use a jump host itself."
                    : undefined
                }
              >
                {(p) => (
                  <Select
                    value={values.jumpHost ?? NONE}
                    onValueChange={(v) =>
                      patch({ jumpHost: v === NONE ? null : v })
                    }
                    disabled={usedAsJump}
                  >
                    <SelectTrigger
                      {...p}
                      size="sm"
                      className="h-8 w-full text-[12px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE} className="text-[12px]">
                        None
                      </SelectItem>
                      {orphanJump ? (
                        <SelectItem
                          value={orphanJump.id}
                          className="text-[12px]"
                        >
                          {orphanJump.name}
                        </SelectItem>
                      ) : null}
                      {candidates.map((c) => (
                        <SelectItem
                          key={c.id}
                          value={c.id}
                          className="text-[12px]"
                        >
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <Field
                  label="Keepalive (seconds)"
                  error={errors.keepaliveSecs}
                  hint="0 disables"
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={0}
                      max={3600}
                      value={values.keepaliveSecs}
                      onChange={(e) => patch({ keepaliveSecs: e.target.value })}
                      className={NUMBER_INPUT}
                    />
                  )}
                </Field>
                <Field
                  label="Default remote folder"
                  error={errors.defaultRemoteDir}
                >
                  {(p) => (
                    <Input
                      {...p}
                      value={values.defaultRemoteDir}
                      onChange={(e) =>
                        patch({ defaultRemoteDir: e.target.value })
                      }
                      placeholder="Optional, for example /var/www"
                      spellCheck={false}
                      autoCapitalize="off"
                      className={cn(INPUT, "font-mono")}
                    />
                  )}
                </Field>
              </div>

              <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1 p-0 text-[11px] font-medium text-muted-foreground">
                  Color
                </legend>
                <ColorRow
                  value={values.color}
                  onChange={(color) => patch({ color })}
                />
              </fieldset>

              <Field
                label="Tags"
                error={errors.tags}
                hint="Separate tags with commas."
              >
                {(p) => (
                  <Input
                    {...p}
                    value={values.tags}
                    onChange={(e) => patch({ tags: e.target.value })}
                    placeholder="prod, database"
                    className={INPUT}
                  />
                )}
              </Field>

              <FavoriteRow
                checked={values.favorite}
                onChange={(favorite) => patch({ favorite })}
              />
            </div>

            {formError ? (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-destructive"
              >
                {formError}
              </p>
            ) : null}

            <DialogFooter className="sm:items-center">
              {initial ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive sm:mr-auto"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete server
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void persist(true)}
              >
                {pending === "connect" ? (
                  <Spinner className="size-3.5" />
                ) : null}
                Save and connect
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {pending === "save" ? <Spinner className="size-3.5" /> : null}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this server?</AlertDialogTitle>
            <AlertDialogDescription>
              {`"${initial?.name ?? "This server"}" will be removed along with its saved port forwards and stored credentials. Servers that jump through it will connect directly instead.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void deleteProfile()}
            >
              Delete server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  stored,
  storedNoun,
  onClear,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  stored: boolean;
  storedNoun: string;
  onClear: () => void;
}) {
  return (
    <Field
      label={label}
      hint={
        stored ? (
          <span className="flex flex-wrap items-center gap-x-2">
            <span>A {storedNoun} is stored. Leave empty to keep it.</span>
            <button
              type="button"
              onClick={onClear}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Clear stored {storedNoun}
            </button>
          </span>
        ) : undefined
      }
    >
      {(p) => (
        <Input
          {...p}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Optional"
          className={INPUT}
        />
      )}
    </Field>
  );
}

function ColorRow({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  const known = PROFILE_COLORS.some((c) => c.value === value);
  const swatches =
    value && !known
      ? [...PROFILE_COLORS, { name: "Current color", value }]
      : PROFILE_COLORS;
  const ring = "ring-offset-2 ring-offset-popover";
  return (
    <div className="flex flex-wrap items-center gap-2 px-0.5 py-0.5">
      <button
        type="button"
        aria-pressed={value === null}
        aria-label="No color"
        title="No color"
        onClick={() => onChange(null)}
        className={cn(
          "flex size-5 items-center justify-center rounded-full border border-border text-muted-foreground outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
          ring,
          value === null
            ? "ring-2 ring-foreground"
            : "hover:ring-2 hover:ring-foreground/30",
        )}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
      </button>
      {swatches.map((c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={value === c.value}
          aria-label={c.name}
          title={c.name}
          onClick={() => onChange(c.value)}
          style={{ backgroundColor: c.value }}
          className={cn(
            "size-5 rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
            ring,
            value === c.value
              ? "ring-2 ring-foreground"
              : "hover:ring-2 hover:ring-foreground/30",
          )}
        />
      ))}
    </div>
  );
}

function FavoriteRow({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id} className="text-[12px] font-medium">
          Favorite
        </Label>
        <span className="text-[10.5px] text-muted-foreground">
          Keep this server easy to find.
        </span>
      </div>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

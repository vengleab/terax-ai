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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  Delete02Icon,
  FileImportIcon,
  Key01Icon,
  LockKeyIcon,
  MoreVerticalIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { sshApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { baseName, expandHome, normalizeLocal } from "../lib/pathOps";
import { useProfilesStore } from "../store/profilesStore";
import { type DialogRequest, useUiStore } from "../store/uiStore";
import type { KeyAlgorithm, KeyInfo, SshProfile } from "../types";
import { Field } from "./ProfileDialog";

type Props = { request: Extract<DialogRequest, { kind: "keys" }> };

type View =
  | { kind: "list" }
  | { kind: "generate" }
  | { kind: "import" }
  | { kind: "passphrase"; key: KeyInfo }
  | { kind: "deploy"; key: KeyInfo };

const INPUT = "h-8 text-[12px] md:text-[12px]";
const MENU = "min-w-44 rounded-2xl p-1";
const MENU_ITEM = "rounded-xl px-2.5 py-1.5 text-xs gap-2";
const RESERVED_NAMES = new Set([
  "config",
  "known_hosts",
  "known_hosts.old",
  "authorized_keys",
  "authorized_keys2",
  "environment",
  "rc",
]);

const ALGORITHMS: { value: KeyAlgorithm; label: string }[] = [
  { value: "ed25519", label: "Ed25519 (recommended)" },
  { value: "ecdsa-p256", label: "ECDSA P-256" },
  { value: "ecdsa-p384", label: "ECDSA P-384" },
  { value: "rsa", label: "RSA" },
];

function keyNameError(name: string, taken: Set<string>): string | null {
  if (!name) return "Enter a name";
  if (
    name.length > 64 ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name.startsWith(".") ||
    name.startsWith("-")
  ) {
    return "Use letters, digits and . _ - only, and do not start with a dot or dash";
  }
  if (name.endsWith(".pub") || RESERVED_NAMES.has(name)) {
    return "That file name is reserved";
  }
  if (taken.has(name)) return "A key with that name already exists";
  return null;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

function defaultKeyName(algorithm: KeyAlgorithm, taken: Set<string>): string {
  const base =
    algorithm === "ed25519"
      ? "id_ed25519"
      : algorithm === "rsa"
        ? "id_rsa"
        : "id_ecdsa";
  return uniqueName(base, taken);
}

function importNameFor(source: string, taken: Set<string>): string {
  const file = baseName(normalizeLocal(source.trim()));
  const cleaned = file
    .replace(/\.pub$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[.-]+/, "")
    .slice(0, 60);
  return cleaned ? uniqueName(cleaned, taken) : "";
}

function profilesUsing(key: KeyInfo, profiles: SshProfile[]): string[] {
  return profiles
    .filter(
      (p) =>
        p.auth.kind === "keyFile" &&
        baseName(normalizeLocal(p.auth.path)) === key.name,
    )
    .map((p) => p.name);
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch (error) {
    toast.error("Could not copy to the clipboard", {
      description: errorMessage(error),
    });
  }
}

export function KeysDialog({ request }: Props) {
  const close = useUiStore((s) => s.close);
  const profiles = useProfilesStore((s) => s.profiles);
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: "list" });
  const [deleting, setDeleting] = useState<KeyInfo | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setKeys(await sshApi.keys());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const backToList = useCallback(async () => {
    await reload();
    setView({ kind: "list" });
  }, [reload]);

  const copyPublic = async (key: KeyInfo) => {
    try {
      await copyText(await sshApi.keyPublic(key.name), "Public key copied");
    } catch (error) {
      toast.error("Could not read the public key", {
        description: errorMessage(error),
      });
    }
  };

  const confirmDelete = async () => {
    const key = deleting;
    if (!key) return;
    setDeleting(null);
    try {
      await sshApi.keyDelete(key.name);
      toast.success(`Key ${key.name} deleted`);
    } catch (error) {
      toast.error("Could not delete the key", {
        description: errorMessage(error),
      });
    }
    await reload();
  };

  const taken = useMemo(() => new Set((keys ?? []).map((k) => k.name)), [keys]);
  const deployTarget = request.deployTo
    ? profiles.find((p) => p.id === request.deployTo)
    : undefined;
  const users = deleting ? profilesUsing(deleting, profiles) : [];

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent className="gap-4 sm:max-w-2xl">
          {view.kind === "list" ? (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8 text-[14px]">SSH keys</DialogTitle>
                <DialogDescription className="text-[12px] leading-relaxed">
                  Key pairs in your ~/.ssh folder. Private keys are never shown.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap items-center justify-between gap-2">
                {deployTarget ? (
                  <p className="min-w-0 text-[11px] text-muted-foreground">
                    {`Pick a key and choose Deploy to server to install it on ${deployTarget.name}.`}
                  </p>
                ) : null}
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setView({ kind: "import" })}
                  >
                    <HugeiconsIcon
                      icon={FileImportIcon}
                      size={12}
                      strokeWidth={1.75}
                    />
                    Import key
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => setView({ kind: "generate" })}
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      size={12}
                      strokeWidth={1.75}
                    />
                    Generate key
                  </Button>
                </div>
              </div>

              <div className="-mx-2 max-h-[50vh] min-h-32 overflow-y-auto px-2 py-0.5">
                {keys === null && loading ? (
                  <div className="flex h-32 items-center justify-center gap-2 text-[12px] text-muted-foreground">
                    <Spinner className="size-3.5" />
                    Loading keys
                  </div>
                ) : loadError ? (
                  <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
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
                      disabled={loading}
                      onClick={() => void reload()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : keys && keys.length === 0 ? (
                  <div className="flex h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 px-4 text-center">
                    <HugeiconsIcon
                      icon={Key01Icon}
                      size={18}
                      strokeWidth={1.5}
                      className="text-muted-foreground"
                    />
                    <p className="text-[12px] font-medium">No SSH keys yet</p>
                    <p className="max-w-xs text-[11px] text-muted-foreground">
                      Generate a new key pair, or import one you already have.
                    </p>
                  </div>
                ) : keys ? (
                  <ul className="flex flex-col gap-1.5">
                    {keys.map((key) => (
                      <KeyRow
                        key={key.name}
                        info={key}
                        onCopyFingerprint={() =>
                          void copyText(key.fingerprint, "Fingerprint copied")
                        }
                        onCopyPublic={() => void copyPublic(key)}
                        onDeploy={() => setView({ kind: "deploy", key })}
                        onPassphrase={() =>
                          setView({ kind: "passphrase", key })
                        }
                        onDelete={() => setDeleting(key)}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>

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
          ) : null}

          {view.kind === "generate" ? (
            <GenerateForm
              taken={taken}
              onBack={() => setView({ kind: "list" })}
              onDone={() => void backToList()}
            />
          ) : null}

          {view.kind === "import" ? (
            <ImportForm
              taken={taken}
              onBack={() => setView({ kind: "list" })}
              onDone={() => void backToList()}
            />
          ) : null}

          {view.kind === "passphrase" ? (
            <PassphraseForm
              info={view.key}
              onBack={() => setView({ kind: "list" })}
              onDone={() => void backToList()}
            />
          ) : null}

          {view.kind === "deploy" ? (
            <DeployForm
              info={view.key}
              preselect={request.deployTo}
              onBack={() => setView({ kind: "list" })}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this key?</AlertDialogTitle>
            <AlertDialogDescription>
              {`The private key file "${deleting?.name ?? ""}" is permanently removed from your ~/.ssh folder, together with its public key file. This cannot be undone, and servers that only accept this key will no longer let you in.`}
              {users.length > 0
                ? ` Servers set up with a key of this name: ${users.join(", ")}.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmDelete()}
            >
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function KeyRow({
  info,
  onCopyFingerprint,
  onCopyPublic,
  onDeploy,
  onPassphrase,
  onDelete,
}: {
  info: KeyInfo;
  onCopyFingerprint: () => void;
  onCopyPublic: () => void;
  onDeploy: () => void;
  onPassphrase: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
        <HugeiconsIcon icon={Key01Icon} size={14} strokeWidth={1.5} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12.5px] font-medium">
            {info.name}
          </span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {info.algorithm}
          </Badge>
          {info.encrypted ? (
            <Badge variant="outline" className="h-4 gap-1 px-1.5 text-[10px]">
              <HugeiconsIcon icon={LockKeyIcon} size={9} strokeWidth={2} />
              passphrase
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span
            className="min-w-0 select-text truncate font-mono"
            title={info.fingerprint}
          >
            {info.fingerprint}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="size-5 shrink-0"
            onClick={onCopyFingerprint}
            aria-label={`Copy fingerprint of ${info.name}`}
            title="Copy fingerprint"
          >
            <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={1.75} />
          </Button>
        </div>
        {info.comment ? (
          <span
            className="truncate text-[11px] text-muted-foreground"
            title={info.comment}
          >
            {info.comment}
          </span>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            aria-label={`Actions for ${info.name}`}
          >
            <HugeiconsIcon
              icon={MoreVerticalIcon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU}>
          <DropdownMenuItem className={MENU_ITEM} onSelect={onCopyPublic}>
            <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.75} />
            Copy public key
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} onSelect={onDeploy}>
            <HugeiconsIcon icon={Upload01Icon} size={13} strokeWidth={1.75} />
            Deploy to server
          </DropdownMenuItem>
          <DropdownMenuItem className={MENU_ITEM} onSelect={onPassphrase}>
            <HugeiconsIcon icon={LockKeyIcon} size={13} strokeWidth={1.75} />
            Change passphrase
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={MENU_ITEM}
            variant="destructive"
            onSelect={onDelete}
          >
            <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function ViewHeader({
  title,
  description,
  onBack,
}: {
  title: string;
  description: ReactNode;
  onBack: () => void;
}) {
  return (
    <DialogHeader>
      <div className="flex items-center gap-1.5 pr-8">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={onBack}
          aria-label="Back to keys"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={1.75} />
        </Button>
        <DialogTitle className="text-[14px]">{title}</DialogTitle>
      </div>
      <DialogDescription className="text-[12px] leading-relaxed">
        {description}
      </DialogDescription>
    </DialogHeader>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-destructive"
    >
      {message}
    </p>
  );
}

function GenerateForm({
  taken,
  onBack,
  onDone,
}: {
  taken: Set<string>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>("ed25519");
  const [name, setName] = useState(() => defaultKeyName("ed25519", taken));
  const [nameTouched, setNameTouched] = useState(false);
  const [comment, setComment] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError = keyNameError(name.trim(), taken);
  const mismatch = passphrase !== confirm ? "Passphrases do not match" : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || nameError || mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const info = await sshApi.keyGenerate({
        name: name.trim(),
        algorithm,
        comment: comment.trim(),
        passphrase: passphrase || undefined,
      });
      toast.success(`Key ${info.name} generated`);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <ViewHeader
        title="Generate key"
        description="Creates a new key pair in your ~/.ssh folder."
        onBack={onBack}
      />
      <fieldset
        disabled={busy}
        className="m-0 flex flex-col gap-3 border-0 p-0"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            error={submitted ? (nameError ?? undefined) : undefined}
          >
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoFocus
                className={`${INPUT} font-mono`}
              />
            )}
          </Field>
          <Field
            label="Algorithm"
            hint={
              algorithm === "rsa"
                ? "RSA generation can take several seconds."
                : undefined
            }
          >
            {(p) => (
              <Select
                value={algorithm}
                onValueChange={(value) => {
                  const next = value as KeyAlgorithm;
                  setAlgorithm(next);
                  if (!nameTouched) setName(defaultKeyName(next, taken));
                }}
              >
                <SelectTrigger
                  {...p}
                  size="sm"
                  className="h-8 w-full text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALGORITHMS.map((a) => (
                    <SelectItem
                      key={a.value}
                      value={a.value}
                      className="text-[12px]"
                    >
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Comment" hint="Optional. Shown next to the public key.">
          {(p) => (
            <Input
              {...p}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="you@laptop"
              spellCheck={false}
              className={INPUT}
            />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Passphrase" hint="Optional. Leave empty for none.">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className={INPUT}
              />
            )}
          </Field>
          <Field
            label="Confirm passphrase"
            error={submitted ? (mismatch ?? undefined) : undefined}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={INPUT}
              />
            )}
          </Field>
        </div>
      </fieldset>
      <FormError message={error} />
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
          {busy ? "Generating" : "Generate key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ImportForm({
  taken,
  onBack,
  onDone,
}: {
  taken: Set<string>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceError = source.trim()
    ? null
    : "Enter the path to a private key file";
  const nameError = keyNameError(name.trim(), taken);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || sourceError || nameError) return;
    setBusy(true);
    setError(null);
    try {
      const home = source.trim().startsWith("~")
        ? await sshApi.fsHome({ kind: "local" })
        : "";
      const info = await sshApi.keyImport(
        expandHome(source, home),
        name.trim(),
      );
      toast.success(`Key ${info.name} imported`);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <ViewHeader
        title="Import key"
        description="Copies a private key you already have into your ~/.ssh folder."
        onBack={onBack}
      />
      <fieldset
        disabled={busy}
        className="m-0 flex flex-col gap-3 border-0 p-0"
      >
        <Field
          label="Private key file"
          error={submitted ? (sourceError ?? undefined) : undefined}
        >
          {(p) => (
            <Input
              {...p}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                if (!nameTouched) {
                  setName(importNameFor(e.target.value, taken));
                }
              }}
              placeholder="~/Downloads/id_ed25519"
              spellCheck={false}
              autoCapitalize="off"
              autoFocus
              className={`${INPUT} font-mono`}
            />
          )}
        </Field>
        <Field
          label="Name"
          hint="The file name used in ~/.ssh."
          error={submitted ? (nameError ?? undefined) : undefined}
        >
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              spellCheck={false}
              autoCapitalize="off"
              className={`${INPUT} font-mono`}
            />
          )}
        </Field>
      </fieldset>
      <FormError message={error} />
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
          Import key
        </Button>
      </DialogFooter>
    </form>
  );
}

function PassphraseForm({
  info,
  onBack,
  onDone,
}: {
  info: KeyInfo;
  onBack: () => void;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentError =
    info.encrypted && !current ? "Enter the current passphrase" : null;
  const mismatch = next !== confirm ? "Passphrases do not match" : null;
  const nothingToDo = !info.encrypted && !next;
  const removing = info.encrypted && !next;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || nothingToDo || currentError || mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await sshApi.keyChangePassphrase(
        info.name,
        info.encrypted ? current : undefined,
        next || undefined,
      );
      toast.success(removing ? "Passphrase removed" : "Passphrase updated");
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <ViewHeader
        title="Change passphrase"
        description={
          <>
            Key <span className="font-mono">{info.name}</span>. Leave the new
            passphrase empty to remove the passphrase.
          </>
        }
        onBack={onBack}
      />
      <fieldset
        disabled={busy}
        className="m-0 flex flex-col gap-3 border-0 p-0"
      >
        {info.encrypted ? (
          <Field
            label="Current passphrase"
            error={submitted ? (currentError ?? undefined) : undefined}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                autoFocus
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className={INPUT}
              />
            )}
          </Field>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="New passphrase">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                autoFocus={!info.encrypted}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                className={INPUT}
              />
            )}
          </Field>
          <Field
            label="Confirm new passphrase"
            error={submitted ? (mismatch ?? undefined) : undefined}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={INPUT}
              />
            )}
          </Field>
        </div>
        {removing ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-700 dark:text-amber-400">
            The key will be saved without a passphrase. Anyone who can read the
            file can use it.
          </p>
        ) : null}
      </fieldset>
      <FormError message={error} />
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
        <Button type="submit" size="sm" disabled={busy || nothingToDo}>
          {busy ? <Spinner className="size-3.5" /> : null}
          {removing
            ? "Remove passphrase"
            : info.encrypted
              ? "Change passphrase"
              : "Set passphrase"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeployForm({
  info,
  preselect,
  onBack,
}: {
  info: KeyInfo;
  preselect?: string;
  onBack: () => void;
}) {
  const profiles = useProfilesStore((s) => s.profiles);
  const connections = useProfilesStore((s) => s.connections);
  const connected = useMemo(
    () => profiles.filter((p) => connections[p.id] !== undefined),
    [profiles, connections],
  );
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected =
    choice && connected.some((p) => p.id === choice)
      ? choice
      : preselect && connected.some((p) => p.id === preselect)
        ? preselect
        : (connected[0]?.id ?? null);
  const wanted = preselect
    ? profiles.find((p) => p.id === preselect)
    : undefined;
  const wantedOffline = wanted && !connected.some((p) => p.id === wanted.id);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const installed = await sshApi.keyDeploy(selected, info.name);
      toast.success(installed ? "Key installed" : "Key was already installed");
      onBack();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <ViewHeader
        title="Deploy to server"
        description={
          <>
            Adds the public key of{" "}
            <span className="font-mono">{info.name}</span> to the server's
            authorized keys, so you can sign in with it.
          </>
        }
        onBack={onBack}
      />
      {connected.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[12px] text-muted-foreground">
          No server is connected. Connect to a server first, then come back to
          install this key.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Server">
            {(p) => (
              <Select
                value={selected ?? undefined}
                onValueChange={setChoice}
                disabled={busy}
              >
                <SelectTrigger
                  {...p}
                  size="sm"
                  className="h-8 w-full text-[12px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connected.map((profile) => (
                    <SelectItem
                      key={profile.id}
                      value={profile.id}
                      className="text-[12px]"
                    >
                      <span>{profile.name}</span>
                      <span className="text-muted-foreground">
                        {profile.user}@{profile.host}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          {wantedOffline ? (
            <p className="text-[11px] text-muted-foreground">
              {wanted.name} is not connected. Connect to it first to deploy
              there.
            </p>
          ) : null}
        </div>
      )}
      <FormError message={error} />
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </Button>
        {connected.length > 0 ? (
          <Button type="submit" size="sm" disabled={busy || !selected}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Deploy
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}

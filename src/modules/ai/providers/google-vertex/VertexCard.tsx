import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderInfo } from "@/modules/ai/config";
import { ProviderIcon } from "@/settings/components/ProviderIcon";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { testConnection } from "./connection";
import {
  isValidLocation,
  isValidProject,
  LOCATION_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "./endpoint";
import { expandHome, normalizePath } from "./keyBrowser";
import { KeyFileBrowser } from "./KeyFileBrowser";
import { readServiceAccountFile } from "./keyFile";
import { accountSummary } from "./serviceAccount";
import { DEFAULT_SETTINGS, type VertexAccountMeta, type VertexSettings, vertexState } from "./settings";

type Props = {
  provider: ProviderInfo;
  /** The path of the chosen key file. Nothing secret reaches this card. */
  token: string | null;
  onSave: (keyFilePath: string) => Promise<void>;
  onClear: () => Promise<void>;
  onRemove: () => void;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] font-medium text-foreground/80">
        {label}
      </label>
      {children}
      {hint ? <span className="text-[10.5px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function VertexCard({ provider, token, onSave, onClear, onRemove }: Props) {
  const connected = !!token;
  const [account, setAccount] = useState<VertexAccountMeta | null>(null);
  const [settings, setSettings] = useState<VertexSettings>(DEFAULT_SETTINGS);
  const [typedPath, setTypedPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([vertexState.getAccount(), vertexState.getSettings()]).then(([meta, saved]) => {
      if (!live) return;
      setAccount(meta);
      setSettings(saved);
    });
    return () => {
      live = false;
    };
  }, []);

  // Tells the user straight away if the chosen file was moved or deleted, rather than at the first chat.
  useEffect(() => {
    if (!token) {
      setFileProblem(null);
      return;
    }
    let live = true;
    void readServiceAccountFile(token).then(
      () => live && setFileProblem(null),
      (e) => live && setFileProblem(describe(e)),
    );
    return () => {
      live = false;
    };
  }, [token]);

  const connectKeyFile = async (rawPath: string) => {
    setError(null);
    setBusy("saving");
    try {
      let path = normalizePath(rawPath.trim());
      if (!path) throw new Error("Choose the service account .json file first.");
      if (path === "~" || path.startsWith("~/")) path = expandHome(path, normalizePath(await homeDir()));
      const sa = await readServiceAccountFile(path);
      const meta = { keyFilePath: path, ...accountSummary(sa) };
      await vertexState.setAccount(meta);
      await onSave(path);
      setAccount(meta);
      setTypedPath("");
      setTestResult(null);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await onClear();
      setAccount(null);
      setTestResult(null);
    } catch (e) {
      setError(describe(e));
    }
  };

  const removeProvider = async () => {
    if (connected) await remove();
    onRemove();
  };

  const update = async (patch: Partial<VertexSettings>) => {
    const next = { ...settings, ...patch };
    if (!isValidLocation(next.location)) {
      setError(`"${next.location}" is not a valid location. Use for example global or us-central1.`);
      return;
    }
    if (next.projectOverride && !isValidProject(next.projectOverride)) {
      setError(`"${next.projectOverride}" is not a valid project id.`);
      return;
    }
    setError(null);
    setSettings(next);
    await vertexState.setSettings(next);
  };

  const test = async () => {
    if (!token) return;
    setError(null);
    setTestResult(null);
    setBusy("testing");
    try {
      const sa = await readServiceAccountFile(token);
      const result = await testConnection(sa, settings);
      setTestResult(result.ok ? { ok: true, text: result.detail } : { ok: false, text: result.message });
    } catch (e) {
      setTestResult({ ok: false, text: describe(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {connected ? (
          <Badge
            variant="outline"
            className="ml-1 h-4 gap-1 border-border/60 bg-muted/40 px-1.5 text-[10px] font-normal text-muted-foreground"
          >
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={9} strokeWidth={2} />
            Connected
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={() => void openUrl(provider.consoleUrl)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Service accounts
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void removeProvider()}
          title="Remove provider"
          className="size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        Use Gemini on Google Cloud with a service account. The account needs the Vertex AI User role and the Vertex
        AI API enabled in its project. Choose the .json key file you downloaded. It is read from where it is, and
        nothing is saved to your keychain.
      </span>

      {connected ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[10.5px] text-muted-foreground">
            {account?.clientEmail ? (
              <span className="truncate" title={account.clientEmail}>
                {account.clientEmail}
              </span>
            ) : null}
            {account?.projectId ? <span>project {account.projectId}</span> : null}
            <span className="truncate" title={token ?? undefined}>
              {token}
            </span>
          </div>
          {fileProblem ? (
            <p role="alert" className="text-[10.5px] leading-relaxed text-destructive">
              {fileProblem}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Field id="vertex-location" label="Location" hint="global, or a region such as us-central1">
              <Input
                id="vertex-location"
                list="vertex-locations"
                value={settings.location}
                onChange={(e) => setSettings((s) => ({ ...s, location: e.target.value }))}
                onBlur={() => void update({ location: settings.location.trim() })}
                spellCheck={false}
                className="h-8 font-mono text-[11.5px]"
              />
              <datalist id="vertex-locations">
                {LOCATION_SUGGESTIONS.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Field>
            <Field id="vertex-model" label="Model" hint="A Gemini model id on Vertex AI">
              <Input
                id="vertex-model"
                list="vertex-models"
                value={settings.modelId}
                onChange={(e) => setSettings((s) => ({ ...s, modelId: e.target.value }))}
                onBlur={() => void update({ modelId: settings.modelId.trim() })}
                spellCheck={false}
                className="h-8 font-mono text-[11.5px]"
              />
              <datalist id="vertex-models">
                {MODEL_SUGGESTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field
            id="vertex-project"
            label="Project override (optional)"
            hint="Leave empty to use the service account's own project"
          >
            <Input
              id="vertex-project"
              value={settings.projectOverride}
              onChange={(e) => setSettings((s) => ({ ...s, projectOverride: e.target.value }))}
              onBlur={() => void update({ projectOverride: settings.projectOverride.trim() })}
              placeholder={account?.projectId ?? ""}
              spellCheck={false}
              className="h-8 font-mono text-[11.5px]"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void test()}
              disabled={busy !== null}
              className="h-8 gap-1.5 text-[11.5px]"
            >
              {busy === "testing" ? <Spinner className="size-3" /> : null}
              Test connection
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBrowsing(true)}
              disabled={busy !== null}
              className="h-8 text-[11.5px]"
            >
              Change file…
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void remove()}
              disabled={busy !== null}
              title="Forget this key file. The file itself is not deleted."
              className="h-8 text-[11.5px]"
            >
              Disconnect
            </Button>
          </div>
          {testResult ? (
            <p className={testResult.ok ? "text-[10.5px] text-emerald-600" : "text-[10.5px] text-destructive"}>
              {testResult.text}
            </p>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void connectKeyFile(typedPath);
          }}
        >
          <Field id="vertex-key-file" label="Key file">
            <Input
              id="vertex-key-file"
              value={typedPath}
              onChange={(e) => setTypedPath(e.target.value)}
              placeholder="~/Downloads/my-project-1a2b3c.json"
              spellCheck={false}
              autoComplete="off"
              className="h-8 font-mono text-[11.5px]"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => setBrowsing(true)}
              disabled={busy !== null}
              className="h-8 text-[11.5px]"
            >
              Find file…
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={busy !== null || !typedPath.trim()}
              className="h-8 gap-1.5 text-[11.5px]"
            >
              {busy === "saving" ? <Spinner className="size-3" /> : null}
              Use this path
            </Button>
          </div>
        </form>
      )}

      {error ? <p className="text-[10.5px] leading-relaxed text-destructive">{error}</p> : null}

      <KeyFileBrowser open={browsing} onOpenChange={setBrowsing} onPick={(path) => void connectKeyFile(path)} />
    </div>
  );
}

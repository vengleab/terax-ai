import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { resolveSecret } from "@/modules/ai/lib/lazyKeys";
import type { ProviderInfo } from "@/modules/ai/config";
import { ProviderIcon } from "@/settings/components/ProviderIcon";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { testConnection } from "./connection";
import { loadAccountText, removeAccountParts, storeAccountText } from "./credentialStore";
import {
  isValidLocation,
  isValidProject,
  LOCATION_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "./endpoint";
import { accountSummary, parseServiceAccount } from "./serviceAccount";
import { DEFAULT_SETTINGS, type VertexAccountMeta, type VertexSettings, vertexState } from "./settings";

type Props = {
  provider: ProviderInfo;
  token: string | null;
  onSave: (pointer: string) => Promise<void>;
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
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const saveKey = async (text: string) => {
    setError(null);
    setBusy("saving");
    try {
      const sa = parseServiceAccount(text);
      const pointer = await storeAccountText(text.trim(), account?.parts ?? 0);
      const parts = Number(pointer.split(":")[2]);
      const meta = { ...accountSummary(sa), parts };
      await vertexState.setAccount(meta);
      await onSave(pointer);
      setAccount(meta);
      setPasted("");
      setTestResult(null);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await saveKey(await file.text());
    } catch (e) {
      setError(describe(e));
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const remove = async () => {
    setError(null);
    try {
      await onClear();
      await removeAccountParts(account?.parts ?? 0);
      await vertexState.setAccount(null);
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
      const pointer = await resolveSecret(token);
      if (!pointer) throw new Error("The saved service account could not be read from your keychain.");
      const sa = parseServiceAccount(await loadAccountText(pointer));
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
        AI API enabled in its project. The key file is stored in your OS keychain.
      </span>

      {connected ? (
        <div className="flex flex-col gap-2.5">
          {account ? (
            <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-[10.5px] text-muted-foreground">
              <span className="truncate" title={account.clientEmail}>
                {account.clientEmail}
              </span>
              <span>project {account.projectId}</span>
            </div>
          ) : (
            <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
              Saved in your keychain
            </div>
          )}
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
              onClick={() => void remove()}
              disabled={busy !== null}
              className="h-8 text-[11.5px]"
            >
              Remove key
            </Button>
          </div>
          {testResult ? (
            <p className={testResult.ok ? "text-[10.5px] text-emerald-600" : "text-[10.5px] text-destructive"}>
              {testResult.text}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='Paste the service account JSON key, or choose the downloaded file'
            spellCheck={false}
            autoComplete="off"
            className="min-h-20 font-mono text-[10.5px]"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void saveKey(pasted)}
              disabled={busy !== null || !pasted.trim()}
              className="h-8 gap-1.5 text-[11.5px]"
            >
              {busy === "saving" ? <Spinner className="size-3" /> : null}
              Save key
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
              className="h-8 text-[11.5px]"
            >
              Choose file…
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void chooseFile(e.target.files?.[0])}
            />
          </div>
        </div>
      )}

      {error ? <p className="text-[10.5px] leading-relaxed text-destructive">{error}</p> : null}
    </div>
  );
}

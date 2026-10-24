import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderInfo } from "@/modules/ai/config";
import { ProviderIcon } from "@/settings/components/ProviderIcon";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import {
  listModels,
  pickDefaultModel,
  sessionFor,
  type CopilotModel,
} from "./copilotApi";
import {
  DeviceFlowError,
  pollForToken,
  requestDeviceCode,
  type DeviceCode,
} from "./deviceFlow";
import { copilotState } from "./selection";

type Props = {
  provider: ProviderInfo;
  token: string | null;
  onSave: (token: string) => Promise<void>;
  onClear: () => Promise<void>;
  onRemove: () => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; code: DeviceCode }
  | { kind: "finishing" };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CopilotCard({ provider, token, onSave, onClear, onRemove }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<CopilotModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([copilotState.getModels(), copilotState.getModelId()]).then(
      ([cached, id]) => {
        if (!live) return;
        setModels(cached);
        setSelected(id);
      },
    );
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, []);

  const applyModels = async (list: CopilotModel[]) => {
    await copilotState.setModels(list);
    setModels(list);
    const current = await copilotState.getModelId();
    if (!current || !list.some((m) => m.id === current)) {
      const pick = pickDefaultModel(list);
      await copilotState.setModelId(pick);
      setSelected(pick);
    }
  };

  const refresh = async () => {
    if (!token) return;
    setLoadingModels(true);
    setError(null);
    try {
      sessionFor(token).invalidate();
      await applyModels(await listModels(token));
    } catch (e) {
      setError(describe(e));
    } finally {
      setLoadingModels(false);
    }
  };

  const signIn = async () => {
    setError(null);
    setPhase({ kind: "starting" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const code = await requestDeviceCode();
      setPhase({ kind: "waiting", code });
      void openUrl(code.verificationUri).catch(() => {});
      const oauth = await pollForToken(code, { signal: controller.signal });
      setPhase({ kind: "finishing" });
      const list = await listModels(oauth);
      await applyModels(list);
      await onSave(oauth);
      setPhase({ kind: "idle" });
    } catch (e) {
      setPhase({ kind: "idle" });
      if (!(e instanceof DeviceFlowError && e.kind === "cancelled")) {
        setError(describe(e));
      }
    } finally {
      abortRef.current = null;
    }
  };

  const signOut = async () => {
    setError(null);
    try {
      await onClear();
      await copilotState.clear();
      setModels([]);
      setSelected(null);
    } catch (e) {
      setError(describe(e));
    }
  };

  const choose = async (id: string) => {
    setSelected(id);
    await copilotState.setModelId(id);
  };

  const busy = phase.kind === "starting" || phase.kind === "finishing";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider={provider.id} size={15} />
        <span className="text-[12.5px] font-medium">{provider.label}</span>
        {token ? (
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
          About
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
        <Button
          size="icon"
          variant="ghost"
          onClick={onRemove}
          title="Remove provider"
          className="size-7 text-muted-foreground hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        Sign in with GitHub to use the models in your Copilot plan. This uses the
        same sign-in as editor plugins. It is unofficial, so GitHub may change or
        block it.
      </span>

      {token ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Select
              value={selected ?? undefined}
              onValueChange={(v) => void choose(v)}
              disabled={models.length === 0}
            >
              <SelectTrigger className="h-8 flex-1 text-[11.5px]">
                <SelectValue
                  placeholder={models.length === 0 ? "No models loaded" : "Pick a model"}
                />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-[11.5px]">
                    {m.name}
                    {m.preview ? " (preview)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="outline"
              onClick={() => void refresh()}
              disabled={loadingModels}
              title="Refresh models"
              className="size-8"
            >
              {loadingModels ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void signOut()}
              className="h-8 text-[11.5px]"
            >
              Sign out
            </Button>
          </div>
        </div>
      ) : phase.kind === "waiting" ? (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
          <span className="text-[10.5px] text-muted-foreground">
            Enter this code at{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => void openUrl(phase.code.verificationUri)}
            >
              {phase.code.verificationUri}
            </button>
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[18px] font-semibold tracking-[0.2em]">
              {phase.code.userCode}
            </span>
            <Button
              size="icon"
              variant="ghost"
              title="Copy code"
              className="size-7"
              onClick={() =>
                void navigator.clipboard.writeText(phase.code.userCode).catch(() => {})
              }
            >
              <HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />
            </Button>
            <span className="ml-auto flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <Spinner className="size-3" />
              Waiting for you to authorize…
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            size="sm"
            onClick={() => void signIn()}
            disabled={busy}
            className="h-8 gap-1.5 text-[11.5px]"
          >
            {busy ? <Spinner className="size-3" /> : null}
            {phase.kind === "finishing" ? "Finishing…" : "Sign in with GitHub"}
          </Button>
        </div>
      )}

      {error ? (
        <p className="text-[10.5px] leading-relaxed text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

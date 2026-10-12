import { AI_PROVIDERS, type AiProvider, modelsFor, needsApiKey, needsModelName, providerLabel, type SupportedProvider, VSCODE_LM } from "./settings";

export type PickItem<T> = { label: string; description?: string; detail?: string; value: T };

/** The providers to choose from, with whether a key is already stored for each. */
export function providerItems(hasKey: (provider: AiProvider) => boolean, current: AiProvider): PickItem<AiProvider>[] {
  return AI_PROVIDERS.map((provider) => {
    const needs = needsApiKey(provider);
    const note = provider === VSCODE_LM ? "uses your sign-in in VS Code, no key" : needs ? (hasKey(provider) ? "key saved" : "no key yet") : "no key needed";
    const description = [provider === current ? "current" : "", note].filter(Boolean).join(" · ");
    return { label: providerLabel(provider), description, value: provider };
  });
}

/** The models VS Code has, for the picker. The first entry leaves the choice to Terax (a Copilot model). */
export function languageModelItems(models: readonly { id: string; vendor: string; name: string; family: string; maxInputTokens: number }[], current: string): PickItem<string>[] {
  const items: PickItem<string>[] = [{ label: "Default", description: current === "" ? "current" : "", detail: "The first GitHub Copilot model VS Code offers", value: "" }];
  for (const m of models) {
    const value = `${m.vendor}/${m.id}`;
    items.push({
      label: m.name,
      description: `${m.vendor} · ${m.id}${value === current ? " · current" : ""}`,
      detail: `${m.family}, up to ${m.maxInputTokens.toLocaleString("en-US")} tokens of input`,
      value,
    });
  }
  return items;
}

/** What can be picked as a model: Terax's list for the provider, and always a way to type a name. */
export const OTHER_MODEL = Symbol("other-model");

export function modelItems(provider: SupportedProvider, current: string): PickItem<string | typeof OTHER_MODEL>[] {
  const items: PickItem<string | typeof OTHER_MODEL>[] = modelsFor(provider).map((m) => ({
    label: m.label,
    description: m.id === current ? `${m.id} · current` : m.id,
    detail: m.description,
    value: m.id,
  }));
  items.push({
    label: needsModelName(provider) ? "Enter the model name…" : "Other model…",
    description: needsModelName(provider) ? "for example the name shown by your server" : "any model id the provider accepts",
    value: OTHER_MODEL,
  });
  return items;
}

/** Keeps a prompt about the editor's selection within a size a chat message can carry. */
const MAX_SELECTION_CHARS = 12_000;

export function selectionPrompt(file: string, language: string, text: string, startLine: number): string {
  const clipped = text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}\n… (cut here, ${text.length - MAX_SELECTION_CHARS} more characters)` : text;
  // The fence is longer than any run of backticks inside, so the code cannot end it early.
  const longest = Math.max(0, ...(clipped.match(/`+/g) ?? []).map((run) => run.length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `About ${file} (from line ${startLine}):\n\n${marks}${language}\n${clipped}\n${marks}\n\n`;
}

import { describe, expect, it } from "vitest";
import { modelItems, OTHER_MODEL, providerItems, selectionPrompt } from "./pickers";
import { SUPPORTED_PROVIDERS } from "./settings";

describe("providerItems", () => {
  it("lists every supported provider once, saying what each still needs", () => {
    const items = providerItems((p) => p === "openai", "anthropic");
    expect(items.map((i) => i.value)).toEqual([...SUPPORTED_PROVIDERS]);
    expect(items.find((i) => i.value === "openai")?.description).toBe("key saved");
    expect(items.find((i) => i.value === "anthropic")?.description).toBe("current · no key yet");
    expect(items.find((i) => i.value === "ollama")?.description).toBe("no key needed");
  });
});

describe("modelItems", () => {
  it("lists Terax's models by their real id, and always offers another name", () => {
    const items = modelItems("openai", "");
    expect(items.length).toBeGreaterThan(1);
    expect(items.at(-1)?.value).toBe(OTHER_MODEL);
    expect(items.slice(0, -1).every((i) => typeof i.value === "string")).toBe(true);
  });

  it("marks the current model", () => {
    const first = modelItems("openai", "")[0].value as string;
    expect(modelItems("openai", first)[0].description).toContain("current");
  });

  it("only asks for a name where Terax has no list", () => {
    const items = modelItems("ollama", "");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ value: OTHER_MODEL, label: "Enter the model name…" });
  });
});

describe("selectionPrompt", () => {
  it("quotes the code with its file and line, ready for a question to follow", () => {
    expect(selectionPrompt("src/a.ts", "typescript", "const a = 1;", 10)).toBe("About src/a.ts (from line 10):\n\n```typescript\nconst a = 1;\n```\n\n");
  });

  it("uses a longer fence when the code contains one", () => {
    const text = selectionPrompt("README.md", "markdown", "```js\nx\n```", 1);
    expect(text).toContain("````markdown\n```js\nx\n```\n````");
  });

  it("cuts a very large selection and says so", () => {
    const text = selectionPrompt("big.txt", "", "x".repeat(20_000), 1);
    expect(text.length).toBeLessThan(13_000);
    expect(text).toContain("cut here");
  });
});

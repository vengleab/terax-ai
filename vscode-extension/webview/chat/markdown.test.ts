import { describe, expect, it } from "vitest";
import { type Inline, parseInline, parseMarkdown } from "./markdown";

const text = (s: string): Inline => ({ t: "text", text: s });

describe("parseInline", () => {
  it("reads plain text as text", () => {
    expect(parseInline("hello world")).toEqual([text("hello world")]);
  });

  it("reads code, bold and italic", () => {
    expect(parseInline("use `npm test` now")).toEqual([text("use "), { t: "code", text: "npm test" }, text(" now")]);
    expect(parseInline("a **bold** b")).toEqual([text("a "), { t: "strong", children: [text("bold")] }, text(" b")]);
    expect(parseInline("a *slanted* b")).toEqual([text("a "), { t: "em", children: [text("slanted")] }, text(" b")]);
  });

  it("does not treat snake_case or a multiplication sign as italic", () => {
    expect(parseInline("call my_var_name and 2*3*4")).toEqual([text("call my_var_name and 2*3*4")]);
  });

  it("keeps markup inside code as it was written", () => {
    expect(parseInline("`<b>**x**</b>`")).toEqual([{ t: "code", text: "<b>**x**</b>" }]);
  });

  it("supports code spans with several backticks around a backtick", () => {
    expect(parseInline("``a`b``")).toEqual([{ t: "code", text: "a`b" }]);
  });

  it("makes links only for addresses the host would open", () => {
    expect(parseInline("see [docs](https://example.com/a)")).toEqual([
      text("see "),
      { t: "link", href: "https://example.com/a", children: [text("docs")] },
    ]);
    expect(parseInline("[mail](mailto:a@b.c)")[0]).toMatchObject({ t: "link" });
    for (const bad of ["javascript:alert(1)", "command:workbench.action.reloadWindow", "file:///etc/passwd", "data:text/html,x"]) {
      const out = parseInline(`[click](${bad})`);
      expect(out.every((n) => n.t === "text")).toBe(true);
    }
  });

  it("never produces HTML: angle brackets stay text", () => {
    const out = parseInline("<img src=x onerror=alert(1)> <script>x</script>");
    expect(out).toEqual([text("<img src=x onerror=alert(1)> <script>x</script>")]);
  });

  it("lets a backslash escape a markup character", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([text("*not italic*")]);
  });

  it("leaves unmatched markers as text", () => {
    expect(parseInline("a ** b and ` c")).toEqual([text("a ** b and ` c")]);
  });
});

describe("parseMarkdown", () => {
  it("separates paragraphs at blank lines and joins wrapped lines", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      { t: "p", inlines: [text("one\ntwo")] },
      { t: "p", inlines: [text("three")] },
    ]);
  });

  it("reads headings", () => {
    expect(parseMarkdown("## Title ##")).toEqual([{ t: "h", level: 2, inlines: [text("Title")] }]);
  });

  it("reads fenced code with its language, exactly as written", () => {
    const blocks = parseMarkdown("Here:\n```ts\nconst a = 1;\n\n  indented();\n```\nDone.");
    expect(blocks).toEqual([
      { t: "p", inlines: [text("Here:")] },
      { t: "code", lang: "ts", text: "const a = 1;\n\n  indented();", open: false },
      { t: "p", inlines: [text("Done.")] },
    ]);
  });

  it("shows code that is still arriving as an open block", () => {
    expect(parseMarkdown("```sh\nnpm te")).toEqual([{ t: "code", lang: "sh", text: "npm te", open: true }]);
  });

  it("closes a four-backtick fence only with four", () => {
    const blocks = parseMarkdown("````md\n```js\nx\n```\n````");
    expect(blocks).toEqual([{ t: "code", lang: "md", text: "```js\nx\n```", open: false }]);
  });

  it("reads bullet and numbered lists, with wrapped item lines", () => {
    expect(parseMarkdown("- one\n- two\n  more\n- three")).toEqual([
      { t: "list", ordered: false, start: 1, items: [[text("one")], [text("two more")], [text("three")]] },
    ]);
    expect(parseMarkdown("3. a\n4. b")).toEqual([{ t: "list", ordered: true, start: 3, items: [[text("a")], [text("b")]] }]);
  });

  it("reads block quotes and rules", () => {
    expect(parseMarkdown("> quoted\n> more")).toEqual([{ t: "quote", inlines: [text("quoted\nmore")] }]);
    expect(parseMarkdown("---")).toEqual([{ t: "hr" }]);
  });

  it("handles Windows line endings and empty input", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toHaveLength(2);
    expect(parseMarkdown("")).toEqual([]);
  });

  it("keeps a long answer fast to read", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} with \`code\` and **bold**`).join("\n");
    const started = Date.now();
    parseMarkdown(big);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

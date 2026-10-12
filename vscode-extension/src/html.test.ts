import { describe, expect, it } from "vitest";
import { buildHtml, makeNonce } from "./html";

const parts = { nonce: "abc123", cspSource: "https://file+.vscode-resource.vscode-cdn.net", scriptUri: "https://x/main.js", styleUri: "https://x/index.css" };

describe("buildHtml", () => {
  const html = buildHtml(parts);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";

  it("only lets the script with the nonce run, and allows WebAssembly", () => {
    expect(csp).toContain("script-src 'nonce-abc123' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(html).toContain('<script nonce="abc123" src="https://x/main.js"></script>');
  });

  it("blocks everything it does not name", () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src ${parts.cspSource}`);
    expect(csp).not.toContain("*");
    expect(csp).not.toMatch(/https?:\/\/(?!file\+)/);
  });

  it("has the elements the page's script looks for", () => {
    expect(html).toContain('id="tabs"');
    expect(html).toContain('id="stage"');
    expect(html).toContain('href="https://x/index.css"');
  });
});

describe("makeNonce", () => {
  it("is url-safe and different each time", () => {
    const a = makeNonce((n) => crypto.getRandomValues(new Uint8Array(n)));
    const b = makeNonce((n) => crypto.getRandomValues(new Uint8Array(n)));
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
  });
});

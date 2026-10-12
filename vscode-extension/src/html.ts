export type HtmlParts = {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
};

/**
 * The page. Scripts need the nonce; `wasm-unsafe-eval` is what lets the terminal engine's
 * WebAssembly module start; nothing may be fetched except from the extension's own files.
 */
export function buildHtml({ nonce, cspSource, scriptUri, styleUri }: HtmlParts): string {
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `connect-src ${cspSource}`,
    `font-src ${cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Terax Terminal</title>
</head>
<body>
<div id="app">
<div id="tabs" role="tablist"></div>
<div id="stage"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function makeNonce(random: (length: number) => Uint8Array): string {
  return Buffer.from(random(18)).toString("base64url");
}

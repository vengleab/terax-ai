import { isOpenableLink } from "../../shared/messages";

/**
 * A small, safe Markdown reader for the chat. It produces a tree, never HTML, so nothing a model
 * writes can become markup or script: the page builds elements from this tree with `textContent`.
 * It covers what the agent writes: paragraphs, headings, lists, quotes, fenced code, and inline code,
 * bold, italic and links.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] };

export type Block =
  | { t: "p"; inlines: Inline[] }
  | { t: "h"; level: number; inlines: Inline[] }
  | { t: "code"; lang: string; text: string; open: boolean }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "quote"; inlines: Inline[] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ t: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const marks = "`".repeat(run);
      const end = text.indexOf(marks, i + run);
      if (end > i + run) {
        flush();
        out.push({ t: "code", text: text.slice(i + run, end).replace(/^ (.*) $/s, "$1") });
        i = end + run;
        continue;
      }
      buffer += marks;
      i += run;
      continue;
    }
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch && text[i + 1] !== " " && !isWordChar(text[i - 1])) {
      let end = i + 1;
      for (; end < text.length; end++) {
        if (text[end] === ch && text[end - 1] !== " " && !isWordChar(text[end + 1])) break;
      }
      if (end < text.length && end > i + 1) {
        flush();
        out.push({ t: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const close = text.indexOf("](", i + 1);
      const end = close > 0 ? text.indexOf(")", close + 2) : -1;
      if (close > i + 1 && end > close) {
        const href = text.slice(close + 2, end).trim();
        // Only links the host would open; anything else is shown as plain text, not as a link.
        if (isOpenableLink(href)) {
          flush();
          out.push({ t: "link", href, children: parseInline(text.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ t: "p", inlines: parseInline(paragraph.join("\n")) });
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const candidate = lines[i].trim();
        if (candidate.startsWith(marker[0].repeat(marker.length)) && candidate.split(marker[0]).join("") === "") {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ t: "code", lang: fence[2], text: body.join("\n"), open: !closed });
      continue;
    }

    if (!line.trim()) {
      endParagraph();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ t: "h", level: heading[1].length, inlines: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      endParagraph();
      const items: Inline[][] = [];
      const isOrdered = !!ordered;
      const start = ordered ? Number(ordered[1]) : 1;
      while (i < lines.length) {
        const m = isOrdered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        const parts = [m[isOrdered ? 2 : 1]];
        i++;
        // A wrapped line belongs to the item above it.
        while (i < lines.length && /^ {2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        items.push(parseInline(parts.join(" ")));
      }
      blocks.push({ t: "list", ordered: isOrdered, start, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      endParagraph();
      const parts: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        parts.push(m[1]);
        i++;
      }
      blocks.push({ t: "quote", inlines: parseInline(parts.join("\n")) });
      continue;
    }

    paragraph.push(line);
    i++;
  }
  endParagraph();
  return blocks;
}

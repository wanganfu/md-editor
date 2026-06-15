import katex from "katex";
import type { MarkedExtension } from "marked";

const KATEX_OPTIONS = {
  throwOnError: false,
  strict: "ignore" as const,
  trust: true,
};

const BLOCK_PLACEHOLDER = "XMDMATHBLOCK";
const INLINE_PLACEHOLDER = "XMDMATHINLINE";
const HTML_LINE_PLACEHOLDER = "XMDHTMLLINE";

const blockHtml: string[] = [];
const inlineHtml: string[] = [];
const htmlLineBlocks: string[] = [];

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function renderInlineMath(text: string): string {
  return katex.renderToString(text.trim(), {
    ...KATEX_OPTIONS,
    displayMode: false,
  });
}

function renderDisplayMath(text: string): string {
  return katex.renderToString(text.trim(), {
    ...KATEX_OPTIONS,
    displayMode: true,
  });
}

function stashBlock(html: string): string {
  const id = blockHtml.length;
  blockHtml.push(html);
  return `\n\n${BLOCK_PLACEHOLDER}${id}${BLOCK_PLACEHOLDER}\n\n`;
}

function stashInline(html: string): string {
  const id = inlineHtml.length;
  inlineHtml.push(html);
  return `${INLINE_PLACEHOLDER}${id}${INLINE_PLACEHOLDER}`;
}

function isStandaloneHtmlLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("<") || trimmed.startsWith("<!--")) {
    return false;
  }

  if (/^<[A-Za-z][\w-]*(?:\s[^>]*)?\/>$/.test(trimmed)) {
    return true;
  }

  const voidMatch = trimmed.match(/^<([A-Za-z][\w-]*)(\s[^>]*)?>$/);
  if (voidMatch && VOID_HTML_ELEMENTS.has(voidMatch[1].toLowerCase())) {
    return true;
  }

  const openMatch = trimmed.match(/^<([A-Za-z][\w-]*)(\s[^>]*?)?>/);
  if (!openMatch) {
    return false;
  }

  const tag = openMatch[1];
  const closeSuffix = new RegExp(`</${tag}\\s*>\\s*$`, "i");
  return closeSuffix.test(trimmed);
}

function stashHtmlLine(html: string): string {
  const id = htmlLineBlocks.length;
  htmlLineBlocks.push(html);
  return `\n\n${HTML_LINE_PLACEHOLDER}${id}${HTML_LINE_PLACEHOLDER}\n\n`;
}

function matchBeginEndBlock(
  src: string,
  start: number
): { end: number; text: string } | null {
  const slice = src.slice(start);
  if (!slice.startsWith("\\begin{")) return null;

  let depth = 0;
  let i = 0;

  while (i < slice.length) {
    const rest = slice.slice(i);
    const begin = rest.match(/^\\begin\{([^}]*)\}/);
    const end = rest.match(/^\\end\{([^}]*)\}/);

    if (begin) {
      depth += 1;
      i += begin[0].length;
      continue;
    }

    if (end) {
      depth -= 1;
      i += end[0].length;
      if (depth === 0) {
        return { end: start + i, text: slice.slice(0, i).trim() };
      }
      continue;
    }

    i += 1;
  }

  return null;
}

function matchDelimited(
  src: string,
  start: number,
  open: string,
  close: string
): { end: number; text: string } | null {
  if (!src.startsWith(open, start)) return null;
  const closeIndex = src.indexOf(close, start + open.length);
  if (closeIndex < 0) return null;
  return {
    end: closeIndex + close.length,
    text: src.slice(start + open.length, closeIndex).trim(),
  };
}

function protectSegment(src: string): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const rest = src.slice(i);

    if (rest.startsWith("\\begin{")) {
      const block = matchBeginEndBlock(src, i);
      if (block?.text) {
        out += stashBlock(renderDisplayMath(block.text));
        i = block.end;
        continue;
      }
    }

    if (rest.startsWith("$$")) {
      const block = matchDelimited(src, i, "$$", "$$");
      if (block?.text) {
        out += stashBlock(renderDisplayMath(block.text));
        i = block.end;
        continue;
      }
    }

    if (rest.startsWith("\\[")) {
      const block = matchDelimited(src, i, "\\[", "\\]");
      if (block?.text) {
        out += stashBlock(renderDisplayMath(block.text));
        i = block.end;
        continue;
      }
    }

    if (rest.startsWith("\\(")) {
      const block = matchDelimited(src, i, "\\(", "\\)");
      if (block?.text) {
        out += stashInline(renderInlineMath(block.text));
        i = block.end;
        continue;
      }
    }

    if (rest[0] === "$" && rest[1] !== "$") {
      const close = rest.indexOf("$", 1);
      if (close > 1) {
        out += stashInline(renderInlineMath(rest.slice(1, close)));
        i += close + 1;
        continue;
      }
    }

    out += src[i];
    i += 1;
  }

  return out;
}

function lineStartIndex(src: string, pos: number): number {
  const nl = src.lastIndexOf("\n", pos - 1);
  return nl === -1 ? 0 : nl + 1;
}

function readLine(src: string, pos: number): { start: number; end: number; text: string } {
  const start = lineStartIndex(src, pos);
  let end = src.indexOf("\n", start);
  if (end === -1) end = src.length;
  return { start, end, text: src.slice(start, end) };
}

function advancePastNewline(src: string, pos: number): number {
  if (pos < src.length && src[pos] === "\r") pos += 1;
  if (pos < src.length && src[pos] === "\n") pos += 1;
  return pos;
}

function matchFencedCodeBlock(
  src: string,
  pos: number
): { end: number; text: string } | null {
  const line = readLine(src, pos);
  if (pos !== line.start) return null;

  const open = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!open) return null;

  const fenceChar = open[1][0];
  const openLen = open[1].length;
  let cursor = advancePastNewline(src, line.end);

  while (cursor <= src.length) {
    if (cursor >= src.length) {
      return { end: src.length, text: src.slice(line.start) };
    }

    const current = readLine(src, cursor);
    const close = current.text.match(/^ {0,3}(`{3,}|~{3,})(?: +|$)/);
    if (close && close[1][0] === fenceChar && close[1].length >= openLen) {
      return {
        end: advancePastNewline(src, current.end),
        text: src.slice(line.start, advancePastNewline(src, current.end)),
      };
    }

    cursor = advancePastNewline(src, current.end);
  }

  return { end: src.length, text: src.slice(line.start) };
}

function matchIndentedCodeBlock(
  src: string,
  pos: number
): { end: number; text: string } | null {
  const line = readLine(src, pos);
  if (pos !== line.start) return null;
  if (!/^ {4}|\t/.test(line.text)) return null;

  let cursor = line.start;
  let blockEnd = line.end;

  while (cursor < src.length) {
    const current = readLine(src, cursor);
    if (current.text.length === 0) {
      const nextPos = advancePastNewline(src, current.end);
      if (nextPos >= src.length) {
        blockEnd = current.end;
        break;
      }
      const next = readLine(src, nextPos);
      if (/^ {4}|\t/.test(next.text)) {
        blockEnd = next.end;
        cursor = nextPos;
        continue;
      }
      break;
    }

    if (!/^ {4}|\t/.test(current.text)) break;
    blockEnd = current.end;
    cursor = advancePastNewline(src, current.end);
  }

  return {
    end: advancePastNewline(src, blockEnd),
    text: src.slice(line.start, advancePastNewline(src, blockEnd)),
  };
}

function matchInlineCode(
  src: string,
  pos: number
): { end: number; text: string } | null {
  if (src[pos] !== "`") return null;

  let openLen = 0;
  while (src[pos + openLen] === "`") openLen += 1;

  let cursor = pos + openLen;
  while (cursor < src.length) {
    if (src[cursor] === "`") {
      let closeLen = 0;
      while (src[cursor + closeLen] === "`") closeLen += 1;
      if (closeLen >= openLen) {
        const end = cursor + openLen;
        return { end, text: src.slice(pos, end) };
      }
      cursor += closeLen;
      continue;
    }
    cursor += 1;
  }

  return null;
}

function matchProtectedRegion(
  src: string,
  pos: number
): { end: number; text: string } | null {
  return (
    matchFencedCodeBlock(src, pos) ??
    matchIndentedCodeBlock(src, pos) ??
    matchInlineCode(src, pos)
  );
}

function findNextProtectedStart(src: string, from: number): number {
  for (let i = from; i < src.length; i += 1) {
    if (matchProtectedRegion(src, i)) return i;

    const line = readLine(src, i);
    if (i === line.start) {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line.text)) return i;
      if (/^ {4}|\t/.test(line.text)) return i;
    }

    if (src[i] === "`") return i;
  }

  return src.length;
}

function protectMathInMarkdown(src: string): string {
  blockHtml.length = 0;
  inlineHtml.length = 0;
  htmlLineBlocks.length = 0;

  let out = "";
  let i = 0;

  while (i < src.length) {
    const protectedRegion = matchProtectedRegion(src, i);
    if (protectedRegion) {
      out += protectedRegion.text;
      i = protectedRegion.end;
      continue;
    }

    const line = readLine(src, i);
    if (i === line.start && isStandaloneHtmlLine(line.text)) {
      out += stashHtmlLine(line.text.trim());
      i = advancePastNewline(src, line.end);
      continue;
    }

    const next = findNextProtectedStart(src, i + 1);
    out += protectSegment(src.slice(i, next));
    i = next;
  }

  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacePlaceholders(html: string): string {
  let result = html;

  for (let id = 0; id < htmlLineBlocks.length; id++) {
    const token = `${HTML_LINE_PLACEHOLDER}${id}${HTML_LINE_PLACEHOLDER}`;
    const re = new RegExp(
      `<p>\\s*${escapeRegExp(token)}\\s*</p>|${escapeRegExp(token)}`,
      "g"
    );
    result = result.replace(re, htmlLineBlocks[id]);
  }

  for (let id = 0; id < blockHtml.length; id++) {
    const token = `${BLOCK_PLACEHOLDER}${id}${BLOCK_PLACEHOLDER}`;
    const re = new RegExp(
      `<p>\\s*${escapeRegExp(token)}\\s*</p>|${escapeRegExp(token)}`,
      "g"
    );
    result = result.replace(re, blockHtml[id]);
  }

  for (let id = 0; id < inlineHtml.length; id++) {
    const token = `${INLINE_PLACEHOLDER}${id}${INLINE_PLACEHOLDER}`;
    result = result.replace(
      new RegExp(escapeRegExp(token), "g"),
      inlineHtml[id]
    );
  }

  return result;
}

export function markedMathExtension(): MarkedExtension {
  return {
    hooks: {
      preprocess(src) {
        return protectMathInMarkdown(src);
      },
      postprocess(html) {
        return replacePlaceholders(html);
      },
    },
  };
}

export function clearMathPlaceholders(): void {
  blockHtml.length = 0;
  inlineHtml.length = 0;
  htmlLineBlocks.length = 0;
}

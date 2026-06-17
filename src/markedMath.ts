import type { MarkedExtension } from "marked";
import { renderKatexCached } from "./katexCache";

const BLOCK_PLACEHOLDER = "XMDMATHBLOCK";
const INLINE_PLACEHOLDER = "XMDMATHINLINE";

const blockHtml: string[] = [];
const inlineHtml: string[] = [];

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
  return renderKatexCached(text, false);
}

function renderDisplayMath(text: string): string {
  return renderKatexCached(text, true);
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

function isInsideDisplayMathBlock(src: string, pos: number): boolean {
  let i = 0;
  while (i < pos) {
    const dollarBlock = matchStandaloneDollarBlock(src, i);
    if (dollarBlock) {
      if (pos < dollarBlock.end) return true;
      i = dollarBlock.end;
      continue;
    }

    const bracketBlock = matchStandaloneBracketBlock(src, i);
    if (bracketBlock) {
      if (pos < bracketBlock.end) return true;
      i = bracketBlock.end;
      continue;
    }

    if (src.startsWith("\\begin{", i)) {
      const block = matchBeginEndBlock(src, i);
      if (block) {
        if (pos < block.end) return true;
        i = block.end;
        continue;
      }
    }

    i += 1;
  }

  return false;
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

/** 独立成行的 $$...$$：整行只有公式，或多行块（首尾行各一个 $$） */
function matchStandaloneDollarBlock(
  src: string,
  start: number
): { end: number; text: string } | null {
  const line = readLine(src, start);
  if (start !== line.start || !src.startsWith("$$", start)) return null;

  const trimmed = line.text.trim();
  const singleLine = trimmed.match(/^\$\$([\s\S]*?)\$\$$/);
  if (singleLine) {
    return {
      end: advancePastNewline(src, line.end),
      text: singleLine[1].trim(),
    };
  }

  if (trimmed !== "$$") return null;

  const contentStart = advancePastNewline(src, line.end);
  let cursor = contentStart;

  while (cursor < src.length) {
    const current = readLine(src, cursor);
    if (current.text.trim() === "$$") {
      return {
        end: advancePastNewline(src, current.end),
        text: src.slice(contentStart, current.start).trim(),
      };
    }
    cursor = advancePastNewline(src, current.end);
  }

  return null;
}

/** 独立成行的 \[...\]：整行只有公式，或多行块（首尾行各一个 \[ / \]） */
function matchStandaloneBracketBlock(
  src: string,
  start: number
): { end: number; text: string } | null {
  const line = readLine(src, start);
  if (start !== line.start || !src.startsWith("\\[", start)) return null;

  const trimmed = line.text.trim();
  const singleLine = trimmed.match(/^\\\[([\s\S]*?)\\\]$/);
  if (singleLine) {
    return {
      end: advancePastNewline(src, line.end),
      text: singleLine[1].trim(),
    };
  }

  if (trimmed !== "\\[") return null;

  const contentStart = advancePastNewline(src, line.end);
  let cursor = contentStart;

  while (cursor < src.length) {
    const current = readLine(src, cursor);
    if (current.text.trim() === "\\]") {
      return {
        end: advancePastNewline(src, current.end),
        text: src.slice(contentStart, current.start).trim(),
      };
    }
    cursor = advancePastNewline(src, current.end);
  }

  return null;
}

function protectSegment(src: string): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const rest = src.slice(i);

    if (rest.startsWith("$$")) {
      const block = matchStandaloneDollarBlock(src, i);
      if (block) {
        out += stashBlock(renderDisplayMath(block.text));
        i = block.end;
        continue;
      }
      out += "$$";
      i += 2;
      continue;
    }

    if (rest.startsWith("\\[")) {
      const block = matchStandaloneBracketBlock(src, i);
      if (block) {
        out += stashBlock(renderDisplayMath(block.text));
        i = block.end;
        continue;
      }
      out += "\\[";
      i += 2;
      continue;
    }

    if (rest.startsWith("\\]")) {
      out += "\\]";
      i += 2;
      continue;
    }

    if (rest.startsWith("\\begin{") && !isInsideDisplayMathBlock(src, i)) {
      const block = matchBeginEndBlock(src, i);
      if (block) {
        out += stashBlock(renderDisplayMath(block.text.trim()));
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
      if (close > 1 && rest[close + 1] !== "$") {
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

function tryStashDisplayBlock(
  src: string,
  i: number
): { out: string; next: number } | null {
  const dollarBlock = matchStandaloneDollarBlock(src, i);
  if (dollarBlock) {
    return {
      out: stashBlock(renderDisplayMath(dollarBlock.text)),
      next: dollarBlock.end,
    };
  }

  const bracketBlock = matchStandaloneBracketBlock(src, i);
  if (bracketBlock) {
    return {
      out: stashBlock(renderDisplayMath(bracketBlock.text)),
      next: bracketBlock.end,
    };
  }

  if (src.startsWith("\\begin{", i) && !isInsideDisplayMathBlock(src, i)) {
    const block = matchBeginEndBlock(src, i);
    if (block) {
      return {
        out: stashBlock(renderDisplayMath(block.text.trim())),
        next: block.end,
      };
    }
  }

  return null;
}

function findNextProtectedStart(src: string, from: number): number {
  for (let i = from; i < src.length; i += 1) {
    if (matchProtectedRegion(src, i)) return i;

    const line = readLine(src, i);
    if (i === line.start) {
      if (/^ {0,3}(`{3,}|~{3,})/.test(line.text)) return i;
      if (/^ {4}|\t/.test(line.text)) return i;
      if (
        !isInsideDisplayMathBlock(src, i) &&
        isStandaloneHtmlLine(line.text)
      ) {
        return i;
      }
      if (matchStandaloneDollarBlock(src, i)) return i;
      if (matchStandaloneBracketBlock(src, i)) return i;
      if (
        src.startsWith("\\begin{", i) &&
        !isInsideDisplayMathBlock(src, i)
      ) {
        return i;
      }
    }

    if (matchInlineCode(src, i)) return i;
  }

  return src.length;
}

function protectMathInMarkdown(src: string): string {
  blockHtml.length = 0;
  inlineHtml.length = 0;

  let out = "";
  let i = 0;

  while (i < src.length) {
    const protectedRegion = matchProtectedRegion(src, i);
    if (protectedRegion) {
      out += protectedRegion.text;
      i = protectedRegion.end;
      continue;
    }

    const displayBlock = tryStashDisplayBlock(src, i);
    if (displayBlock) {
      out += displayBlock.out;
      i = displayBlock.next;
      continue;
    }

    const line = readLine(src, i);
    if (
      i === line.start &&
      !isInsideDisplayMathBlock(src, i) &&
      isStandaloneHtmlLine(line.text)
    ) {
      out += `${line.text.trim()}\n`;
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
}

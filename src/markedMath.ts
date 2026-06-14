import katex from "katex";
import type { MarkedExtension } from "marked";

const KATEX_OPTIONS = {
  throwOnError: false,
  strict: "ignore" as const,
  trust: true,
};

const BLOCK_PLACEHOLDER = "XMDMATHBLOCK";
const INLINE_PLACEHOLDER = "XMDMATHINLINE";

const blockHtml: string[] = [];
const inlineHtml: string[] = [];

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

function protectMathInMarkdown(src: string): string {
  blockHtml.length = 0;
  inlineHtml.length = 0;

  const parts = src.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : protectSegment(part)))
    .join("");
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

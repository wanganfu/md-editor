import { hashContent } from "./previewMorph";

export type MarkdownBlock = {
  index: number;
  content: string;
  hash: string;
};

function readLine(
  src: string,
  pos: number
): { start: number; end: number; text: string } {
  const start = src.lastIndexOf("\n", pos - 1) + 1;
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

const LIST_LINE_RE = /^ {0,3}(?:[-*+]|[-*+]\s\[[ xX]\]|\d+\.)\s/;
const TABLE_LINE_RE = /^\s*\|/;
const BLOCKQUOTE_LINE_RE = /^ {0,3}>\s?/;

function isMergeableWithPrevious(prev: string, current: string): boolean {
  const prevLine = prev.split("\n").pop() ?? "";
  const currentLine = current.split("\n")[0] ?? "";
  if (LIST_LINE_RE.test(prevLine) && LIST_LINE_RE.test(currentLine)) {
    return true;
  }
  if (TABLE_LINE_RE.test(prevLine) && TABLE_LINE_RE.test(currentLine)) {
    return true;
  }
  if (BLOCKQUOTE_LINE_RE.test(prevLine) && BLOCKQUOTE_LINE_RE.test(currentLine)) {
    return true;
  }
  return false;
}

function mergeAdjacentChunks(chunks: string[]): string[] {
  if (chunks.length === 0) return chunks;

  const merged: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const current = chunks[i];
    const prev = merged[merged.length - 1];
    if (isMergeableWithPrevious(prev, current)) {
      merged[merged.length - 1] = `${prev}\n\n${current}`;
    } else {
      merged.push(current);
    }
  }
  return merged;
}

export function splitMarkdownIntoBlocks(source: string): MarkdownBlock[] {
  if (!source) return [];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < source.length) {
    while (pos < source.length && source[pos] === "\n") {
      pos += 1;
    }
    if (pos >= source.length) break;

    const fence = matchFencedCodeBlock(source, pos);
    if (fence) {
      chunks.push(fence.text);
      pos = fence.end;
      continue;
    }

    let end = pos;
    while (end < source.length) {
      if (source[end] === "\n") {
        const next = advancePastNewline(source, end);
        if (next < source.length) {
          const nextFence = matchFencedCodeBlock(source, next);
          if (nextFence) {
            break;
          }
        }
        if (next < source.length && source[next] === "\n") {
          end = next;
          break;
        }
        end = next;
        continue;
      }
      end += 1;
    }

    const chunk = source.slice(pos, end).replace(/\n+$/, "");
    if (chunk.length > 0) chunks.push(chunk);
    pos = end < source.length ? advancePastNewline(source, end) : end;
  }

  const merged = mergeAdjacentChunks(chunks);
  return merged.map((content, index) => ({
    index,
    content,
    hash: hashContent(content),
  }));
}

export function findDirtyBlockIndices(
  blocks: MarkdownBlock[],
  previousHashes: string[]
): number[] {
  const dirty: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i >= previousHashes.length || blocks[i].hash !== previousHashes[i]) {
      dirty.push(i);
    }
  }
  if (blocks.length > previousHashes.length) {
    for (let i = previousHashes.length; i < blocks.length; i++) {
      if (!dirty.includes(i)) dirty.push(i);
    }
  }
  return dirty;
}

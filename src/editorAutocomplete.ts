export type EditorAutocompleteOptions = {
  editor: HTMLTextAreaElement;
  onApplied: () => void;
};

function getLineBounds(
  text: string,
  cursor: number
): {
  lineStart: number;
  lineEnd: number;
  lineText: string;
  column: number;
} {
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const lineEnd = text.indexOf("\n", cursor);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return {
    lineStart,
    lineEnd: end,
    lineText: text.slice(lineStart, end),
    column: cursor - lineStart,
  };
}

function isInsideCodeFence(text: string, pos: number): boolean {
  const before = text.slice(0, pos);
  const fences = before.match(/```/g);
  return fences !== null && fences.length % 2 === 1;
}

function linePrefixOnly(lineText: string): string {
  return lineText.match(/^\s*/)?.[0] ?? "";
}

function isAtLineContentStart(lineText: string, column: number): boolean {
  return column === linePrefixOnly(lineText).length;
}

function replaceRange(
  editor: HTMLTextAreaElement,
  start: number,
  end: number,
  insert: string,
  cursor: number,
  selectionEnd?: number
): void {
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  editor.value = before + insert + after;
  editor.selectionStart = cursor;
  editor.selectionEnd = selectionEnd ?? cursor;
}

function applyAndNotify(
  editor: HTMLTextAreaElement,
  onApplied: () => void
): void {
  onApplied();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

const PAIR_OPEN_TO_CLOSE: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
  $: "$",
  _: "_",
  "*": "*",
};

export function initEditorAutocomplete(
  options: EditorAutocompleteOptions
): void {
  const { editor, onApplied } = options;
  let isComposing = false;

  function notify() {
    applyAndNotify(editor, onApplied);
  }

  function insertPair(
    open: string,
    close: string,
    pos: number,
    inner = ""
  ): void {
    const insert = open + inner + close;
    replaceRange(editor, pos, pos, insert, pos + open.length + inner.length);
    notify();
  }

  function wrapSelection(open: string, close: string): boolean {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start === end) return false;
    const selected = editor.value.slice(start, end);
    replaceRange(
      editor,
      start,
      end,
      open + selected + close,
      start + open.length,
      start + open.length + selected.length
    );
    notify();
    return true;
  }

  function handleLineStartExpansion(): void {
    const cursor = editor.selectionStart;
    const { lineStart, lineText } = getLineBounds(editor.value, cursor);

    let suffix: string | null = null;
    if (lineText === "-" || lineText === "*" || lineText === "+") {
      suffix = " ";
    } else if (lineText === ">") {
      suffix = " ";
    } else if (/^\d+\.$/.test(lineText)) {
      suffix = " ";
    } else if (lineText === "- [") {
      suffix = "] ";
    }

    if (!suffix) return;

    const insertAt = lineStart + lineText.length;
    replaceRange(editor, insertAt, insertAt, suffix, insertAt + suffix.length);
    notify();
  }

  function handleStarKey(pos: number): boolean {
    const { lineStart, lineText, column } = getLineBounds(editor.value, pos);
    const before = editor.value.slice(lineStart, pos);
    const atContentStart = isAtLineContentStart(lineText, column);

    if (atContentStart && lineText.trim() === "") {
      return false;
    }

    if (atContentStart && before.trim() === "*") {
      return false;
    }

    if (before.endsWith("**")) {
      const after = editor.value.slice(pos);
      if (after.startsWith("**")) {
        editor.selectionStart = pos + 2;
        editor.selectionEnd = pos + 2;
        return true;
      }
      return false;
    }

    if (before.endsWith("*")) {
      const openStar = pos - 1;
      const hasClosingStar = editor.value[pos] === "*";
      const replaceEnd = hasClosingStar ? pos + 1 : pos;
      replaceRange(editor, openStar, replaceEnd, "****", openStar + 2);
      notify();
      return true;
    }

    insertPair("*", "*", pos);
    return true;
  }

  function handlePairKey(key: string, pos: number): boolean {
    const close = PAIR_OPEN_TO_CLOSE[key];
    if (!close) return false;

    const next = editor.value[pos];
    if (next === close) {
      editor.selectionStart = pos + 1;
      editor.selectionEnd = pos + 1;
      return true;
    }

    insertPair(key, close, pos);
    return true;
  }

  function handleBracketClose(pos: number): boolean {
    const before = editor.value.slice(0, pos);
    if (!/\[[^\]\n]+$/.test(before)) return false;

    const after = editor.value.slice(pos);
    if (after.startsWith("(")) return false;

    replaceRange(editor, pos, pos, "](url)", pos + 2, pos + 5);
    notify();
    return true;
  }

  function handleEnter(): boolean {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start !== end) return false;

    const { lineStart, lineEnd, lineText } = getLineBounds(editor.value, start);

    if (isInsideCodeFence(editor.value, start)) {
      if (lineText.trim() === "```") {
        const insert = "\n\n```";
        replaceRange(editor, start, start, insert, start + 1);
        notify();
        return true;
      }
      return false;
    }

    if (lineText.trim() === "```") {
      const insert = "\n\n```";
      replaceRange(editor, start, start, insert, start + 1);
      notify();
      return true;
    }

    const taskMatch = lineText.match(/^(\s*)-\s\[[ xX]\]\s*(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1];
      const content = taskMatch[2];
      if (content.trim() === "") {
        replaceRange(editor, lineStart, lineEnd, "", lineStart);
      } else {
        const insert = `\n${indent}- [ ] `;
        replaceRange(editor, start, start, insert, start + insert.length);
      }
      notify();
      return true;
    }

    const ulMatch = lineText.match(/^(\s*)([-*+])\s+(.*)$/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const marker = ulMatch[2];
      const content = ulMatch[3];
      if (content.trim() === "") {
        replaceRange(editor, lineStart, lineEnd, "", lineStart);
      } else {
        const insert = `\n${indent}${marker} `;
        replaceRange(editor, start, start, insert, start + insert.length);
      }
      notify();
      return true;
    }

    const olMatch = lineText.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      const indent = olMatch[1];
      const num = parseInt(olMatch[2], 10);
      const content = olMatch[3];
      if (content.trim() === "") {
        replaceRange(editor, lineStart, lineEnd, "", lineStart);
      } else {
        const insert = `\n${indent}${num + 1}. `;
        replaceRange(editor, start, start, insert, start + insert.length);
      }
      notify();
      return true;
    }

    const quoteMatch = lineText.match(/^(\s*)>\s?(.*)$/);
    if (quoteMatch) {
      const indent = quoteMatch[1];
      const content = quoteMatch[2];
      if (content.trim() === "") {
        replaceRange(editor, lineStart, lineEnd, "", lineStart);
      } else {
        const insert = `\n${indent}> `;
        replaceRange(editor, start, start, insert, start + insert.length);
      }
      notify();
      return true;
    }

    const insert = "\n";
    replaceRange(editor, start, start, insert, start + 1);
    notify();
    return true;
  }

  function handleBackspace(): boolean {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start !== end) return false;

    const { lineStart, lineText } = getLineBounds(editor.value, start);
    if (start === 0) return false;

    const open = editor.value[start - 1];
    const close = editor.value[start];
    if (open && close && PAIR_OPEN_TO_CLOSE[open] === close) {
      replaceRange(editor, start - 1, start + 1, "", start - 1);
      notify();
      return true;
    }

    const trimmed = lineText.trimEnd();
    const markers = [
      /^(\s*)-\s\[[ xX]\]\s*$/,
      /^(\s*)([-*+])\s+$/,
      /^(\s*)\d+\.\s+$/,
      /^(\s*)>\s*$/,
    ];
    for (const pattern of markers) {
      if (pattern.test(trimmed) && start === lineStart + lineText.length) {
        replaceRange(editor, lineStart, start, "", lineStart);
        notify();
        return true;
      }
    }

    return false;
  }

  function handleTab(shift: boolean): boolean {
    const start = editor.selectionStart;
    const { lineStart, lineText } = getLineBounds(editor.value, start);

    const listPattern = /^(\s*)(?:-\s\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/;
    if (!listPattern.test(lineText)) return false;

    const indentUnit = "    ";
    const indent = lineText.match(/^(\s*)/)?.[1] ?? "";

    if (shift) {
      if (!indent) return false;
      const remove = indent.endsWith("\t")
        ? indent.slice(0, -1)
        : indent.slice(0, Math.min(indent.length, indentUnit.length));
      const newLine = remove + lineText.slice(indent.length);
      replaceRange(
        editor,
        lineStart,
        lineStart + lineText.length,
        newLine,
        start - (indent.length - remove.length)
      );
      notify();
      return true;
    }

    const newLine = indentUnit + lineText;
    replaceRange(
      editor,
      lineStart,
      lineStart + lineText.length,
      newLine,
      start + indentUnit.length
    );
    notify();
    return true;
  }

  editor.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  editor.addEventListener("compositionend", () => {
    isComposing = false;
  });

  editor.addEventListener("input", () => {
    if (isComposing) return;
    handleLineStartExpansion();
  });

  editor.addEventListener("keydown", (event) => {
    if (isComposing) return;

    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      if (handleEnter()) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === "Backspace") {
      if (handleBackspace()) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === "Tab") {
      if (handleTab(event.shiftKey)) {
        event.preventDefault();
      }
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const key = event.key;

    if (key === "]" && start === end) {
      if (handleBracketClose(start)) {
        event.preventDefault();
      }
      return;
    }

    if (start !== end) {
      if (PAIR_OPEN_TO_CLOSE[key]) {
        if (wrapSelection(key, PAIR_OPEN_TO_CLOSE[key])) {
          event.preventDefault();
        }
      }
      return;
    }

    if (key === "*") {
      if (handleStarKey(start)) {
        event.preventDefault();
      }
      return;
    }

    if (key === "-" || key === "+") {
      const { lineText, column } = getLineBounds(editor.value, start);
      if (isAtLineContentStart(lineText, column) && lineText.trim() === "") {
        return;
      }
    }

    if (handlePairKey(key, start)) {
      event.preventDefault();
    }
  });
}

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";

// ── State ──────────────────────────────────────────────
let currentFilePath: string | null = null;
let isModified = false;
type ViewMode = "edit" | "split" | "preview";
let isDark = false;

// ── DOM refs ──────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const editor = $<HTMLTextAreaElement>("#editor");
const preview = $<HTMLDivElement>("#preview");
const fileName = $<HTMLSpanElement>("#file-name");
const modifiedDot = $<HTMLSpanElement>("#modified-dot");
const statusWords = $<HTMLSpanElement>("#status-words");
const statusChars = $<HTMLSpanElement>("#status-chars");
const statusLines = $<HTMLSpanElement>("#status-lines");
const statusCursor = $<HTMLSpanElement>("#status-cursor");
const statusFilePath = $<HTMLSpanElement>("#status-file-path");

// ── Marked config ──────────────────────────────────────
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ── Preview update (debounced) ─────────────────────────
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function updatePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const md = editor.value;
    preview.innerHTML = marked.parse(md) as string;
    updateStatus();
  }, 100);
}

// ── Status bar ─────────────────────────────────────────
function updateStatus() {
  const text = editor.value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text.split(/\n/).length;
  statusWords.textContent = `${words} 词`;
  statusChars.textContent = `${chars} 字符`;
  statusLines.textContent = `${lines} 行`;

  const cursorPos = editor.selectionStart;
  const textBefore = text.substring(0, cursorPos);
  const line = textBefore.split("\n").length;
  const lastNewline = textBefore.lastIndexOf("\n");
  const col = cursorPos - lastNewline;
  statusCursor.textContent = `行 ${line}, 列 ${col}`;
}

// ── Modified state ─────────────────────────────────────
function markModified() {
  if (!isModified) {
    isModified = true;
    modifiedDot.classList.remove("hidden");
    updateTitle();
  }
}

function markSaved() {
  isModified = false;
  modifiedDot.classList.add("hidden");
  updateTitle();
}

function updateTitle() {
  const base = currentFilePath
    ? currentFilePath.split(/[/\\]/).pop() || "未命名"
    : "未命名";
  fileName.textContent = base + (isModified ? " *" : "");
  document.title = (isModified ? "* " : "") + base + " - MD Editor";
  statusFilePath.textContent = currentFilePath || "";
}

// ── File Operations ────────────────────────────────────
async function newFile() {
  if (isModified) {
    if (!confirm("当前文件未保存，是否丢弃更改？")) return;
  }
  editor.value = "";
  currentFilePath = null;
  markSaved();
  updatePreview();
}

async function openFile() {
  try {
    const path = await open({
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
      multiple: false,
    });
    if (path && typeof path === "string") {
      const content = await invoke<string>("read_file", { path });
      editor.value = content;
      currentFilePath = path;
      markSaved();
      updatePreview();
    }
  } catch (e) {
    alert(`打开文件失败: ${e}`);
  }
}

async function saveFile() {
  if (currentFilePath) {
    try {
      await invoke("write_file", { path: currentFilePath, content: editor.value });
      markSaved();
    } catch (e) {
      alert(`保存失败: ${e}`);
    }
  } else {
    await saveFileAs();
  }
}

async function saveFileAs() {
  try {
    const path = await save({
      filters: [
        { name: "Markdown", extensions: ["md", "markdown"] },
        { name: "All Files", extensions: ["*"] },
      ],
      defaultPath: currentFilePath || "untitled.md",
    });
    if (path) {
      await invoke("write_file", { path, content: editor.value });
      currentFilePath = path;
      markSaved();
    }
  } catch (e) {
    alert(`另存失败: ${e}`);
  }
}

// ── View Mode ──────────────────────────────────────────
function setViewMode(mode: ViewMode) {
  const editorPane = document.querySelector("#editor-pane")!;
  const previewPane = document.querySelector("#preview-pane")!;
  const btnEdit = $("#btn-view-edit");
  const btnSplit = $("#btn-view-split");
  const btnPreview = $("#btn-view-preview");

  // Reset all buttons
  [btnEdit, btnSplit, btnPreview].forEach((b) => b.classList.remove("active"));

  switch (mode) {
    case "edit":
      editorPane.classList.remove("hidden");
      editorPane.classList.add("flex");
      previewPane.classList.add("hidden");
      previewPane.classList.remove("flex");
      btnEdit.classList.add("active");
      break;
    case "split":
      editorPane.classList.remove("hidden");
      editorPane.classList.add("flex");
      previewPane.classList.remove("hidden");
      previewPane.classList.add("flex");
      btnSplit.classList.add("active");
      break;
    case "preview":
      editorPane.classList.add("hidden");
      editorPane.classList.remove("flex");
      previewPane.classList.remove("hidden");
      previewPane.classList.add("flex");
      btnPreview.classList.add("active");
      break;
  }
}

// ── Theme Toggle ───────────────────────────────────────
function toggleTheme() {
  isDark = !isDark;
  const html = document.documentElement;
  const btn = $("#btn-theme");
  const icon = btn.querySelector("i")!;
  if (isDark) {
    html.classList.add("dark");
    icon.className = "fa-solid fa-sun";
  } else {
    html.classList.remove("dark");
    icon.className = "fa-solid fa-moon";
  }
}

// ── Toolbar Actions ────────────────────────────────────
interface ToolAction {
  prefix: string;
  suffix: string;
  defaultText: string;
  multiline?: boolean;
  block?: boolean;
}

const actions: Record<string, ToolAction> = {
  bold: { prefix: "**", suffix: "**", defaultText: "粗体文本" },
  italic: { prefix: "*", suffix: "*", defaultText: "斜体文本" },
  strikethrough: { prefix: "~~", suffix: "~~", defaultText: "删除文本" },
  heading1: { prefix: "# ", suffix: "", defaultText: "标题 1", block: true },
  heading2: { prefix: "## ", suffix: "", defaultText: "标题 2", block: true },
  heading3: { prefix: "### ", suffix: "", defaultText: "标题 3", block: true },
  ul: { prefix: "- ", suffix: "", defaultText: "列表项", block: true },
  ol: { prefix: "1. ", suffix: "", defaultText: "列表项", block: true },
  task: { prefix: "- [ ] ", suffix: "", defaultText: "任务", block: true },
  quote: { prefix: "> ", suffix: "", defaultText: "引用", block: true },
  code: { prefix: "`", suffix: "`", defaultText: "code" },
  codeblock: { prefix: "```\n", suffix: "\n```", defaultText: "代码", multiline: true },
  link: { prefix: "[", suffix: "](url)", defaultText: "链接文本" },
  image: { prefix: "![", suffix: "](url)", defaultText: "图片描述" },
  hr: { prefix: "\n---\n", suffix: "", defaultText: "" },
  table: {
    prefix: "\n| 列1 | 列2 | 列3 |\n|-----|-----|-----|\n| ", suffix: " |", defaultText: "内容",
  },
};

function applyToolAction(action: string) {
  const ta = actions[action];
  if (!ta) return;

  const el = editor;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const selected = el.value.substring(start, end);
  const text = selected || ta.defaultText;

  if (ta.block) {
    // For block-level actions: insert at line start
    const lineStart = el.value.lastIndexOf("\n", start - 1) + 1;
    const beforeLine = el.value.substring(0, lineStart);
    const afterLine = el.value.substring(lineStart);

    // If there's a selection, prefix each selected line
    if (selected) {
      const lines = selected.split("\n");
      const prefixed = lines.map((l) => ta.prefix + l).join("\n");
      el.value = el.value.substring(0, start) + prefixed + el.value.substring(end);
      el.selectionStart = start;
      el.selectionEnd = start + prefixed.length;
    } else {
      const replacement = ta.prefix + text;
      el.value = beforeLine + replacement + afterLine;
      const newPos = lineStart + replacement.length;
      el.selectionStart = newPos;
      el.selectionEnd = newPos;
    }
  } else {
    const replacement = ta.prefix + text + ta.suffix;
    el.value = el.value.substring(0, start) + replacement + el.value.substring(end);
    const newEnd = start + replacement.length;
    if (!selected) {
      el.selectionStart = start + ta.prefix.length;
      el.selectionEnd = start + ta.prefix.length + ta.defaultText.length;
    } else {
      el.selectionStart = newEnd;
      el.selectionEnd = newEnd;
    }
  }

  el.focus();
  markModified();
  updatePreview();
}

// ── Event Listeners ────────────────────────────────────
editor.addEventListener("input", () => {
  markModified();
  updatePreview();
});

editor.addEventListener("keyup", updateStatus);
editor.addEventListener("click", updateStatus);

// Toolbar buttons
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = (btn as HTMLElement).dataset.action!;
    applyToolAction(action);
  });
});

// File operation buttons
$("#btn-new").addEventListener("click", newFile);
$("#btn-open").addEventListener("click", openFile);
$("#btn-save").addEventListener("click", saveFile);
$("#btn-save-as").addEventListener("click", saveFileAs);

// View toggle buttons
$("#btn-view-edit").addEventListener("click", () => setViewMode("edit"));
$("#btn-view-split").addEventListener("click", () => setViewMode("split"));
$("#btn-view-preview").addEventListener("click", () => setViewMode("preview"));

// Theme toggle
$("#btn-theme").addEventListener("click", toggleTheme);

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === "s") {
    e.preventDefault();
    if (e.shiftKey) saveFileAs();
    else saveFile();
  } else if (ctrl && e.key === "o") {
    e.preventDefault();
    openFile();
  } else if (ctrl && e.key === "n") {
    e.preventDefault();
    newFile();
  } else if (ctrl && e.key === "b") {
    e.preventDefault();
    applyToolAction("bold");
  } else if (ctrl && e.key === "i") {
    e.preventDefault();
    applyToolAction("italic");
  }
});

// Initialize with sample content
let initialized = false;
window.addEventListener("DOMContentLoaded", () => {
  if (initialized) return;
  initialized = true;

  editor.value = `# 欢迎使用 MD Editor

这是一个轻量化的 **Markdown 编辑器**，基于 Tauri + Tailwind CSS 构建。

## 功能特点

- 🚀 **轻量快速** - Tauri 原生桌面应用，内存占用极小
- 📝 **实时预览** - 编辑与预览同步
- 🎨 **语法高亮** - 支持 GFM 表格、任务列表等
- 🌙 **暗色模式** - 护眼舒适
- ⌨️ **快捷键** - 提升编辑效率

## 示例

### 代码块

\`\`\`javascript
function hello() {
  console.log("Hello, MD Editor!");
}
\`\`\`

### 表格

| 功能 | 状态 |
|------|------|
| 粗体/斜体 | ✅ |
| 标题 | ✅ |
| 列表 | ✅ |
| 任务列表 | ✅ |
| 代码块 | ✅ |

### 任务列表

- [x] 完成基本编辑器
- [x] 添加实时预览
- [ ] 添加更多主题
- [ ] 支持插件扩展

> 引用：轻量、快速、美观——这就是 MD Editor。
`;

  updatePreview();
  updateStatus();
  setViewMode("split");
});

// Handle beforeunload
window.addEventListener("beforeunload", (e) => {
  if (isModified) {
    e.preventDefault();
  }
});

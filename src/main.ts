import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { marked } from "marked";

// ── State ──────────────────────────────────────────────
let currentFilePath: string | null = null;
let currentFolderPath: string | null = null;
let isModified = false;
type ViewMode = "edit" | "split" | "preview";
let isDark = false;
let sidebarVisible = true;

// ── DOM refs ──────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;
const editor = $<HTMLTextAreaElement>("#editor");
const preview = $<HTMLDivElement>("#preview");
const statusWords = $<HTMLSpanElement>("#status-words");
const statusChars = $<HTMLSpanElement>("#status-chars");
const statusLines = $<HTMLSpanElement>("#status-lines");
const statusCursor = $<HTMLSpanElement>("#status-cursor");
const statusFilePath = $<HTMLSpanElement>("#status-file-path");

// ── Window controls ─────────────────────────────────────
const appWindow = getCurrentWindow();
$("#btn-minimize")?.addEventListener("click", () => appWindow.minimize());
$("#btn-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());
$("#btn-close")?.addEventListener("click", () => appWindow.close());

// ── Marked config ──────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });

// ── Preview update (debounced) ─────────────────────────
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function updatePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    preview.innerHTML = marked.parse(editor.value) as string;
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

// ── Title update ───────────────────────────────────────
function updateTitle() {
  const base = currentFilePath
    ? currentFilePath.split(/[/\\]/).pop() || "未命名"
    : "未命名";
  document.title = (isModified ? "* " : "") + base + " - MD Editor";
  statusFilePath.textContent = currentFilePath || "";
}

function markModified() {
  if (!isModified) {
    isModified = true;
    updateTitle();
  }
}

function markSaved() {
  isModified = false;
  updateTitle();
}

// ── Sidebar ────────────────────────────────────────────
function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  const sidebar = $("#sidebar");
  const btn = $("#btn-sidebar-toggle");
  if (sidebarVisible) {
    sidebar.style.width = "240px";
    sidebar.style.minWidth = "240px";
    btn.classList.add("active");
  } else {
    sidebar.style.width = "0px";
    sidebar.style.minWidth = "0px";
    btn.classList.remove("active");
  }
}

async function openFolder() {
  try {
    const folderPath = await open({
      directory: true,
      multiple: false,
      title: "选择文件夹",
    });
    if (folderPath && typeof folderPath === "string") {
      currentFolderPath = folderPath;
      await refreshFileList();
    }
  } catch (e) {
    console.error("打开文件夹失败:", e);
  }
}

async function refreshFileList() {
  if (!currentFolderPath) return;
  try {
    const files: string[] = await invoke("list_md_files", {
      dir: currentFolderPath,
    });
    const list = $("#sidebar-file-list");
    const folderLabel = $("#sidebar-folder-path");
    folderLabel.textContent =
      currentFolderPath.split(/[/\\]/).pop() || currentFolderPath;

    if (files.length === 0) {
      list.innerHTML =
        '<div class="px-3 py-4 text-xs" style="color:var(--text-secondary)">没有找到 Markdown 文件</div>';
      return;
    }

    list.innerHTML = files
      .map((f) => {
        const name = f.split(/[/\\]/).pop() || f;
        const isActive = f === currentFilePath;
        return `<div class="sidebar-file ${isActive ? "active" : ""}" data-path="${f.replace(/"/g, "&quot;")}" title="${f.replace(/"/g, "&quot;")}">
          <i class="fa-solid fa-file-lines shrink-0"></i><span class="truncate">${name}</span>
        </div>`;
      })
      .join("");

    // Click handler
    list.querySelectorAll(".sidebar-file").forEach((item) => {
      item.addEventListener("click", async () => {
        const path = (item as HTMLElement).dataset.path!;
        await openFileByPath(path);
      });
    });
  } catch (e) {
    console.error("列出文件失败:", e);
  }
}

async function openFileByPath(path: string) {
  if (isModified) {
    if (!confirm("当前文件未保存，是否丢弃更改？")) return;
  }
  try {
    const content = await invoke<string>("read_file", { path });
    editor.value = content;
    currentFilePath = path;
    markSaved();
    updatePreview();
    refreshFileList(); // Update active state
  } catch (e) {
    alert(`打开文件失败: ${e}`);
  }
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
  if (currentFolderPath) refreshFileList();
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
      await openFileByPath(path);
    }
  } catch (e) {
    alert(`打开文件失败: ${e}`);
  }
}

// ── Toast ──────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string) {
  const toast = $("#toast");
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.remove("opacity-0", "translate-y-[-1rem]");
  toast.classList.add("opacity-100", "translate-y-0");
  toastTimer = setTimeout(() => {
    toast.classList.add("opacity-0", "translate-y-[-1rem]");
    toast.classList.remove("opacity-100", "translate-y-0");
  }, 1800);
}

async function saveFile() {
  if (currentFilePath) {
    try {
      await invoke("write_file", {
        path: currentFilePath,
        content: editor.value,
      });
      markSaved();
      showToast("已保存");
      if (currentFolderPath) refreshFileList();
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
      showToast("已另存为");
      if (currentFolderPath) refreshFileList();
    }
  } catch (e) {
    alert(`另存失败: ${e}`);
  }
}

// ── View Mode ──────────────────────────────────────────
function setViewMode(mode: ViewMode) {
  const editorPane = document.querySelector("#editor-pane") as HTMLElement;
  const previewPane = document.querySelector("#preview-pane") as HTMLElement;
  const splitter = document.querySelector("#splitter") as HTMLElement;
  const btnEdit = $("#btn-view-edit");
  const btnSplit = $("#btn-view-split");
  const btnPreview = $("#btn-view-preview");

  [btnEdit, btnSplit, btnPreview].forEach((b) =>
    b.classList.remove("active")
  );

  // 拖动分割线会写入内联 flex，单栏模式需清除否则可见面板无法占满宽度
  const clearPaneFlex = () => {
    editorPane.style.flex = "";
    previewPane.style.flex = "";
  };

  switch (mode) {
    case "edit":
      clearPaneFlex();
      editorPane.classList.remove("hidden");
      editorPane.classList.add("flex");
      previewPane.classList.add("hidden");
      previewPane.classList.remove("flex");
      splitter.style.display = "none";
      btnEdit.classList.add("active");
      break;
    case "split":
      editorPane.classList.remove("hidden");
      editorPane.classList.add("flex");
      previewPane.classList.remove("hidden");
      previewPane.classList.add("flex");
      splitter.style.display = "";
      if (!editorPane.style.flex) {
        editorPane.style.flex = "1 1 50%";
        previewPane.style.flex = "1 1 50%";
      }
      btnSplit.classList.add("active");
      break;
    case "preview":
      clearPaneFlex();
      editorPane.classList.add("hidden");
      editorPane.classList.remove("flex");
      previewPane.classList.remove("hidden");
      previewPane.classList.add("flex");
      splitter.style.display = "none";
      btnPreview.classList.add("active");
      break;
  }
}

// ── Theme Toggle ───────────────────────────────────────
function toggleTheme() {
  isDark = !isDark;
  const html = document.documentElement;
  const icon = $("#btn-theme").querySelector("i")!;
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
  heading1: {
    prefix: "# ",
    suffix: "",
    defaultText: "标题 1",
    block: true,
  },
  heading2: {
    prefix: "## ",
    suffix: "",
    defaultText: "标题 2",
    block: true,
  },
  heading3: {
    prefix: "### ",
    suffix: "",
    defaultText: "标题 3",
    block: true,
  },
  ul: { prefix: "- ", suffix: "", defaultText: "列表项", block: true },
  ol: { prefix: "1. ", suffix: "", defaultText: "列表项", block: true },
  task: { prefix: "- [ ] ", suffix: "", defaultText: "任务", block: true },
  quote: { prefix: "> ", suffix: "", defaultText: "引用", block: true },
  code: { prefix: "`", suffix: "`", defaultText: "code" },
  codeblock: {
    prefix: "```\n",
    suffix: "\n```",
    defaultText: "代码",
    multiline: true,
  },
  link: { prefix: "[", suffix: "](url)", defaultText: "链接文本" },
  image: { prefix: "![", suffix: "](url)", defaultText: "图片描述" },
  hr: { prefix: "\n---\n", suffix: "", defaultText: "" },
  table: {
    prefix: "\n| 列1 | 列2 | 列3 |\n|-----|-----|-----|\n| ",
    suffix: " |",
    defaultText: "内容",
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
    const lineStart = el.value.lastIndexOf("\n", start - 1) + 1;
    const beforeLine = el.value.substring(0, lineStart);
    const afterLine = el.value.substring(lineStart);

    if (selected) {
      const lines = selected.split("\n");
      const prefixed = lines.map((l) => ta.prefix + l).join("\n");
      el.value =
        el.value.substring(0, start) + prefixed + el.value.substring(end);
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
    el.value =
      el.value.substring(0, start) + replacement + el.value.substring(end);
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

// File operations
$("#btn-new")?.addEventListener("click", newFile);
$("#btn-open")?.addEventListener("click", openFile);
$("#btn-save")?.addEventListener("click", saveFile);
$("#btn-save-as")?.addEventListener("click", saveFileAs);

// Sidebar
$("#btn-sidebar-toggle")?.addEventListener("click", toggleSidebar);
$("#btn-open-folder")?.addEventListener("click", openFolder);

// View toggle
$("#btn-view-edit")?.addEventListener("click", () => setViewMode("edit"));
$("#btn-view-split")?.addEventListener("click", () => setViewMode("split"));
$("#btn-view-preview")?.addEventListener("click", () => setViewMode("preview"));

// Theme
$("#btn-theme")?.addEventListener("click", toggleTheme);

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

// ── Splitter Drag ─────────────────────────────────────
function initSplitter() {
  const splitter = $("#splitter");
  const editorArea = $("#editor-area");
  const editorPane = $("#editor-pane") as HTMLElement;
  const previewPane = $("#preview-pane") as HTMLElement;
  let dragging = false;

  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = editorArea.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(20, Math.min(80, (x / rect.width) * 100));
    editorPane.style.flex = `0 0 ${pct}%`;
    previewPane.style.flex = `0 0 ${100 - pct}%`;
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
}

// ── Initialize ─────────────────────────────────────────
let initialized = false;
window.addEventListener("DOMContentLoaded", () => {
  if (initialized) return;
  initialized = true;

  initSplitter();

  editor.value = `# 欢迎使用 MD Editor

这是一个轻量化的 **Markdown 编辑器**，基于 Tauri + Tailwind CSS 构建。

## 功能特点

- 🚀 **轻量快速** - Tauri 原生桌面应用
- 📝 **实时预览** - 编辑与预览同步
- 📂 **文件夹浏览** - 点击左侧按钮打开文件夹
- 🎨 **语法高亮** - 支持 GFM 表格、任务列表
- 🌙 **暗色模式** - 太阳/月亮按钮切换
- ⌨️ **快捷键** - \`Ctrl+B\` 粗体、\`Ctrl+S\` 保存

## 快速开始

1. 点击工具栏 📂 **打开文件** 或 📁 **打开文件夹**
2. 开始编辑 Markdown
3. 使用 \`Ctrl+S\` 保存

> 提示：点击左侧 ☰ 按钮展开侧边栏浏览文件

\`\`\`javascript
function hello() {
  console.log("Hello, MD Editor!");
}
\`\`\`

| 功能 | 快捷键 |
|------|--------|
| 粗体 | Ctrl+B |
| 斜体 | Ctrl+I |
| 保存 | Ctrl+S |
| 打开 | Ctrl+O |
| 新建 | Ctrl+N |
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

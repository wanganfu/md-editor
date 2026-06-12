import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { marked } from "marked";

// ── State ──────────────────────────────────────────────
let currentFilePath: string | null = null;
let currentFolderPath: string | null = null;
let isModified = false;
type ViewMode = "edit" | "split" | "preview";
let isDark = false;
let sidebarVisible = false;
let currentViewMode: ViewMode = "split";
let scrollSyncLocked = false;

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

const REMOTE_URL_RE =
  /^(https?:|\/\/|data:|mailto:|javascript:|#|asset:|blob:|https:\/\/asset\.)/i;

function isRemoteResourceUrl(url: string): boolean {
  return REMOTE_URL_RE.test(url);
}

function joinPaths(baseDir: string, relative: string): string {
  const normalizedBase = baseDir.replace(/\\/g, "/");
  const isWin = /^[a-zA-Z]:\//.test(normalizedBase);
  const isUnixAbsolute = normalizedBase.startsWith("/");
  const parts = baseDir.split(/[/\\]/).filter(Boolean);

  for (const segment of relative.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  if (isWin && parts[0]?.endsWith(":")) {
    return parts.join("\\");
  }
  if (isUnixAbsolute) {
    return "/" + parts.join("/");
  }
  return parts.join(isWin ? "\\" : "/");
}

function resolveResourceUrl(href: string): string {
  if (!href || isRemoteResourceUrl(href)) return href;
  if (!currentFilePath) return href;

  try {
    const decoded = decodeURIComponent(href.trim());
    const isAbsolute =
      /^[a-zA-Z]:[/\\]/.test(decoded) ||
      (decoded.startsWith("/") && !decoded.startsWith("//"));

    const absolute = isAbsolute
      ? decoded
      : joinPaths(
          currentFilePath.replace(/[/\\][^/\\]+$/, ""),
          decoded
        );

    return convertFileSrc(absolute);
  } catch {
    return href;
  }
}

function rewriteLocalResourceUrls(html: string): string {
  return html
    .replace(
      /(<img\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi,
      (_match, prefix, quote, src) =>
        `${prefix}${quote}${resolveResourceUrl(src)}${quote}`
    )
    .replace(
      /(<(?:video|audio|source)\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi,
      (_match, prefix, quote, src) =>
        `${prefix}${quote}${resolveResourceUrl(src)}${quote}`
    );
}

marked.use({
  hooks: {
    postprocess(html) {
      return rewriteLocalResourceUrls(html);
    },
  },
});

// ── Preview update (debounced) ─────────────────────────
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function updatePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const syncRatio =
      scrollSyncLocked && currentViewMode === "split"
        ? getScrollRatio(editor)
        : null;

    preview.innerHTML = marked.parse(editor.value) as string;

    if (syncRatio !== null) {
      applyScrollSync("editor", syncRatio);
    }

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
function applySidebarState() {
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

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  applySidebarState();
}

// ── Responsive toolbar ─────────────────────────────────
const TOOLBAR_LAYOUT_HYSTERESIS = 16;
let toolbarCompact = false;

function getMainToolbarAvailableWidth(): number {
  const toolbar = $("#toolbar");
  const left = $("#toolbar-left");
  const right = $("#toolbar-right");
  return toolbar.clientWidth - left.offsetWidth - right.offsetWidth;
}

function setToolbarCompact(compact: boolean) {
  if (toolbarCompact === compact) return;
  toolbarCompact = compact;

  const formatGroup = $("#format-toolbar-group");
  const mainSlot = $("#toolbar-format-slot");
  const secondarySlot = $("#toolbar-format-secondary-slot");
  const secondaryToolbar = $("#toolbar-secondary");
  const toolbar = $("#toolbar");

  if (compact) {
    secondarySlot.appendChild(formatGroup);
    secondaryToolbar.classList.remove("hidden");
    mainSlot.classList.add("is-hidden");
    toolbar.classList.add("toolbar-compact");
  } else {
    mainSlot.appendChild(formatGroup);
    secondaryToolbar.classList.add("hidden");
    mainSlot.classList.remove("is-hidden");
    toolbar.classList.remove("toolbar-compact");
  }
}

function updateToolbarLayout() {
  const formatGroup = $("#format-toolbar-group");
  const formatWidth = formatGroup.scrollWidth;
  const available = getMainToolbarAvailableWidth();

  if (toolbarCompact) {
    if (formatWidth <= available - TOOLBAR_LAYOUT_HYSTERESIS) {
      setToolbarCompact(false);
    }
  } else if (formatWidth > available) {
    setToolbarCompact(true);
  }
}

function initToolbarLayout() {
  const wrap = $("#toolbar-wrap");
  const observer = new ResizeObserver(() => updateToolbarLayout());
  observer.observe(wrap);
  observer.observe($("#toolbar-left"));
  observer.observe($("#toolbar-right"));
  observer.observe($("#format-toolbar-group"));

  appWindow.onResized(() => updateToolbarLayout());

  requestAnimationFrame(() => {
    requestAnimationFrame(updateToolbarLayout);
  });
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
    return true;
  } catch (e) {
    alert(`打开文件失败: ${e}`);
    return false;
  }
}

const MD_EXTENSIONS = new Set(["md", "markdown", "txt"]);

function isMarkdownPath(path: string): boolean {
  const name = path.split(/[/\\]/).pop() || path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return MD_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function isPointInDropZone(x: number, y: number): boolean {
  for (const sel of ["#editor-pane", "#preview-pane"]) {
    const rect = $(sel).getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return true;
    }
  }
  return false;
}

function setDropZoneHighlight(active: boolean) {
  $("#editor-area").classList.toggle("drop-target-active", active);
}

function clearDropZoneHighlight() {
  $("#editor-area").classList.remove("drop-target-active");
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
  currentViewMode = mode;
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

  updateScrollLockButton();
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
$("#btn-scroll-lock")?.addEventListener("click", toggleScrollSyncLock);
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

// ── External file drag & drop ───────────────────────────
let externalDragActive = false;

async function initDragDrop() {
  await appWindow.onDragDropEvent(async (event) => {
    const payload = event.payload;

    if (payload.type === "enter") {
      externalDragActive = true;
      return;
    }

    if (payload.type === "leave") {
      externalDragActive = false;
      clearDropZoneHighlight();
      return;
    }

    if (payload.type === "over") {
      if (!externalDragActive) {
        clearDropZoneHighlight();
        return;
      }
      const factor = await appWindow.scaleFactor();
      const pos = payload.position.toLogical(factor);
      setDropZoneHighlight(isPointInDropZone(pos.x, pos.y));
      return;
    }

    if (payload.type !== "drop") return;

    externalDragActive = false;
    clearDropZoneHighlight();

    try {
      const factor = await appWindow.scaleFactor();
      const pos = payload.position.toLogical(factor);
      if (!isPointInDropZone(pos.x, pos.y)) return;

      const mdFiles = payload.paths.filter(isMarkdownPath);
      if (mdFiles.length === 0) {
        showToast("请拖入 .md / .markdown / .txt 文件");
        return;
      }

      const opened = await openFileByPath(mdFiles[0]);
      if (opened) {
        const name = mdFiles[0].split(/[/\\]/).pop() || mdFiles[0];
        showToast(`已打开 ${name}`);
      }
    } finally {
      externalDragActive = false;
      clearDropZoneHighlight();
    }
  });
}

// ── Sync scroll (split mode, when locked) ──────────────
type ScrollPane = "editor" | "preview";
let scrollSyncSource: ScrollPane | null = null;
let scrollSyncClearTimer: ReturnType<typeof setTimeout> | null = null;

function getScrollRatio(el: HTMLElement): number {
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 0) return 0;
  return el.scrollTop / maxScroll;
}

function setScrollByRatio(el: HTMLElement, ratio: number) {
  const maxScroll = el.scrollHeight - el.clientHeight;
  const top = Math.max(0, Math.min(maxScroll, ratio * maxScroll));
  el.scrollTo({ top, behavior: "instant" });
}

function markScrollSyncSource(source: ScrollPane) {
  scrollSyncSource = source;
  if (scrollSyncClearTimer) clearTimeout(scrollSyncClearTimer);
  scrollSyncClearTimer = setTimeout(() => {
    scrollSyncSource = null;
    scrollSyncClearTimer = null;
  }, 64);
}

function applyScrollSync(source: ScrollPane, ratio?: number) {
  if (!shouldSyncScroll()) return;

  const resolvedRatio =
    ratio ?? getScrollRatio(source === "editor" ? editor : preview);
  const target = source === "editor" ? preview : editor;

  markScrollSyncSource(source);
  setScrollByRatio(target, resolvedRatio);
}

function shouldSyncScroll(): boolean {
  return scrollSyncLocked && currentViewMode === "split";
}

function updateScrollLockButton() {
  const btn = $("#btn-scroll-lock");
  const icon = btn.querySelector("i");
  if (!icon) return;

  if (scrollSyncLocked) {
    btn.classList.add("active");
    btn.title = "取消同步滚动";
    icon.className = "fa-solid fa-lock";
  } else {
    btn.classList.remove("active");
    btn.title = "锁定同步滚动（分屏）";
    icon.className = "fa-solid fa-lock-open";
  }

  btn.classList.toggle("opacity-40", currentViewMode !== "split");
}

function toggleScrollSyncLock() {
  scrollSyncLocked = !scrollSyncLocked;
  updateScrollLockButton();
  if (scrollSyncLocked && currentViewMode === "split") {
    applyScrollSync("editor");
  }
  showToast(scrollSyncLocked ? "已锁定同步滚动" : "已取消同步滚动");
}

function initSyncScroll() {
  editor.addEventListener("scroll", () => {
    if (!shouldSyncScroll() || scrollSyncSource === "preview") return;
    applyScrollSync("editor");
  });

  preview.addEventListener("scroll", () => {
    if (!shouldSyncScroll() || scrollSyncSource === "editor") return;
    applyScrollSync("preview");
  });

  updateScrollLockButton();
}

// ── Settings modal ─────────────────────────────────────
async function updateSettingsDefaultStatus() {
  const status = $("#settings-default-status");
  const btn = $<HTMLButtonElement>("#settings-btn-default-app");
  if (!status || !btn) return;
  btn.disabled = false;
  try {
    const isDefault = await invoke<boolean>("is_md_default_handler");
    if (isDefault) {
      status.textContent = "当前已是 Markdown 默认打开方式";
      btn.textContent = "重新注册默认打开方式";
      btn.classList.add("active");
    } else {
      status.textContent = "尚未设为 Markdown 默认打开方式";
      btn.textContent = "设为默认打开方式";
      btn.classList.remove("active");
    }
  } catch {
    status.textContent = "此功能仅支持 Windows";
    btn.disabled = true;
  }
}

function openSettings() {
  const modal = $("#settings-modal");
  modal.classList.remove("hidden");
  modal.classList.add("open");
  updateSettingsDefaultStatus();
}

function closeSettings() {
  const modal = $("#settings-modal");
  modal.classList.remove("open");
  modal.classList.add("hidden");
}

async function registerDefaultAppFromSettings() {
  try {
    await invoke("register_md_default_handler");
    showToast("已设为 Markdown 默认打开方式");
    await updateSettingsDefaultStatus();
  } catch (e) {
    alert(`设置失败: ${e}`);
  }
}

function initSettings() {
  $("#btn-settings")?.addEventListener("click", openSettings);
  $("#settings-close")?.addEventListener("click", closeSettings);
  $("#settings-backdrop")?.addEventListener("click", closeSettings);
  $("#settings-btn-default-app")?.addEventListener(
    "click",
    registerDefaultAppFromSettings
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#settings-modal").classList.contains("open")) {
      closeSettings();
    }
  });
}

// ── Default app (Windows) ─────────────────────────────
async function openPathsFromSystem(paths: string[]): Promise<boolean> {
  const mdFiles = paths.filter(isMarkdownPath);
  if (mdFiles.length === 0) return false;

  const opened = await openFileByPath(mdFiles[0]);
  if (!opened) return false;

  const parent = mdFiles[0].replace(/[/\\][^/\\]+$/, "");
  if (parent) {
    currentFolderPath = parent;
    await refreshFileList();
  }
  return true;
}

async function initOpenFileListener() {
  await listen<string[]>("open-files", async (event) => {
    await openPathsFromSystem(event.payload);
  });
}

async function openLaunchFiles(): Promise<boolean> {
  try {
    const paths: string[] = await invoke("take_launch_files");
    if (paths.length === 0) return false;
    return openPathsFromSystem(paths);
  } catch (e) {
    console.error("打开启动文件失败:", e);
    return false;
  }
}

// ── Initialize ─────────────────────────────────────────
let initialized = false;
window.addEventListener("DOMContentLoaded", async () => {
  if (initialized) return;
  initialized = true;

  initSplitter();
  initDragDrop();
  initSyncScroll();
  initSettings();
  initToolbarLayout();
  applySidebarState();
  await initOpenFileListener();

  const openedFromLaunch = await openLaunchFiles();
  if (!openedFromLaunch) {
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
  }

  updateStatus();
  setViewMode("split");
});

// Handle beforeunload
window.addEventListener("beforeunload", (e) => {
  if (isModified) {
    e.preventDefault();
  }
});

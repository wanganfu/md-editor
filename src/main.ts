import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { marked } from "marked";
import mermaid from "mermaid";
import "katex/dist/katex.min.css";
import { markedMathExtension } from "./markedMath";
import {
  markAppReady,
  syncBootstrapSettingsToDocument,
} from "./bootstrapSettings";
import {
  applyI18nToDom,
  getLanguage,
  setLanguage,
  t,
  type Language,
} from "./i18n";
import {
  loadAppSettings,
  saveAppSettings,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ViewMode,
  type SidebarTab,
} from "./settings";
import {
  addToDocumentHistory,
  loadDocumentHistory,
  removeFromDocumentHistoryList,
  saveDocumentHistory,
} from "./documentHistory";
import {
  buildAttachmentMarkdown,
  isMarkdownFilePath,
  resolveAttachmentLink,
} from "./objectStorage";
import { hashContent, morphPreviewHtml } from "./previewMorph";

// ── State ──────────────────────────────────────────────
let currentFilePath: string | null = null;
let currentFolderPath: string | null = null;
let isModified = false;
let isDark = false;
let sidebarVisible = false;
let sidebarTab: SidebarTab = "files";
let currentViewMode: ViewMode = "split";
let scrollSyncLocked = false;
let scrollSyncSuspended = false;
let lastTocSignature = "";
let activeTocId: string | null = null;
let tocHighlightRaf: number | null = null;
let documentHistory: string[] = [];
let appSettings: AppSettings = { ...DEFAULT_SETTINGS };

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Marked config ──────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });

marked.use(markedMathExtension());

let previewMermaidBlockIndex = 0;

marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === "mermaid") {
        const index = previewMermaidBlockIndex++;
        const source = text.trim();
        const contentKey = hashContent(source);
        return `<div class="mermaid" id="mermaid-block-${index}" data-mermaid-key="${contentKey}">${escapeHtml(source)}</div>`;
      }

      const langClass = lang
        ? ` class="language-${escapeHtml(lang)}"`
        : "";
      return `<pre><code${langClass}>${escapeHtml(text)}\n</code></pre>\n`;
    },
  },
});

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

interface TocEntry {
  level: number;
  text: string;
  id: string;
  line: number;
}

function extractHeadings(text: string): TocEntry[] {
  const items: TocEntry[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;

    const level = match[1].length;
    const headingText = match[2].trim().replace(/\s+#+\s*$/, "");
    items.push({
      level,
      text: headingText,
      id: `heading-${items.length}`,
      line: i,
    });
  }

  return items;
}

function addHeadingIds(html: string): string {
  let index = 0;
  return html.replace(/<h([1-6])(\s[^>]*)?>/gi, (match, _level, attrs = "") => {
    if (/\bid\s*=/.test(attrs)) return match;
    const id = `heading-${index++}`;
    return `<h${_level} id="${id}"${attrs}>`;
  });
}

function renderFileListEmpty(list: HTMLElement, message: string, icon = "fa-folder-open") {
  list.innerHTML = `<div class="flex flex-col items-center justify-center h-full gap-2 px-3" style="color:var(--text-secondary)">
    <i class="fa-solid ${icon} text-2xl opacity-40"></i>
    <span class="text-xs opacity-60 text-center">${message}</span>
  </div>`;
}

function isDocumentsPanelEnabled(): boolean {
  return appSettings.showSiblingDocuments || appSettings.showHistoryDocuments;
}

function applyDocumentListSplitRatio(ratio: number) {
  const clamped = Math.max(0.2, Math.min(0.8, ratio));
  appSettings = { ...appSettings, documentListSplitRatio: clamped };

  const siblingsWrap = $("#sidebar-siblings-wrap");
  const historyWrap = $("#sidebar-history-wrap");
  const topPct = clamped * 100;
  const bottomPct = 100 - topPct;

  siblingsWrap.style.flex = `0 0 ${topPct}%`;
  historyWrap.style.flex = `1 1 ${bottomPct}%`;
}

function applyDocumentListSectionsLayout() {
  const showSiblings = appSettings.showSiblingDocuments;
  const showHistory = appSettings.showHistoryDocuments;
  const both = showSiblings && showHistory;

  $("#sidebar-siblings-wrap").classList.toggle("hidden", !showSiblings);
  $("#sidebar-history-wrap").classList.toggle("hidden", !showHistory);

  const splitter = $("#sidebar-files-splitter");
  splitter.classList.toggle("hidden", !both);
  splitter.setAttribute("aria-hidden", both ? "false" : "true");

  if (both) {
    applyDocumentListSplitRatio(appSettings.documentListSplitRatio);
  } else {
    $("#sidebar-siblings-wrap").style.flex = "1 1 100%";
    $("#sidebar-history-wrap").style.flex = "1 1 100%";
  }
}

function updateSidebarDocumentsVisibility() {
  const showDocs = isDocumentsPanelEnabled();
  const filesTab = $("#sidebar-tab-files");
  const tabs = $(".sidebar-tabs");

  filesTab.classList.toggle("hidden", !showDocs);
  tabs.classList.toggle("sidebar-tabs-single", !showDocs);

  if (!showDocs) {
    $("#sidebar-file-panel").classList.add("hidden");
    $("#sidebar-toc-list").classList.remove("hidden");
    return;
  }

  tabs.classList.remove("sidebar-tabs-single");
  applyDocumentListSectionsLayout();
}

function resolveSidebarTab(tab: SidebarTab): SidebarTab {
  if (!isDocumentsPanelEnabled()) return "toc";
  if (tab === "files") return "files";
  return "toc";
}

function renderTocList() {
  const list = $("#sidebar-toc-list");
  const headings = extractHeadings(editor.value);
  lastTocSignature = getTocSignature(headings);

  if (headings.length === 0) {
    activeTocId = null;
    list.innerHTML = `<div class="flex flex-col items-center justify-center h-full gap-2 px-3" style="color:var(--text-secondary)">
      <i class="fa-solid fa-list-ul text-2xl opacity-40"></i>
      <span class="text-xs opacity-60 text-center">${t("sidebar.noHeadings")}</span>
    </div>`;
    return;
  }

  list.innerHTML = headings
    .map((heading) => {
      const indent = (heading.level - 1) * 0.75 + 0.6;
      const safeText = escapeHtml(heading.text);
      const isActive = activeTocId === heading.id;
      return `<div class="sidebar-toc-item${isActive ? " active" : ""}" data-id="${heading.id}" data-line="${heading.line}" title="${safeText}" style="padding-left:${indent}rem">
        <span class="toc-level-dot"></span>
        <span class="truncate">${safeText}</span>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".sidebar-toc-item").forEach((item) => {
    item.addEventListener("click", () => {
      const el = item as HTMLElement;
      scrollToHeading(el.dataset.id!, Number(el.dataset.line));
    });
  });

  updateTocHighlight();
}

function getTocSignature(headings: ReturnType<typeof extractHeadings>): string {
  return headings
    .map((heading) => `${heading.level}:${heading.id}:${heading.text}:${heading.line}`)
    .join("|");
}

function renderTocListIfNeeded() {
  const headings = extractHeadings(editor.value);
  const signature = getTocSignature(headings);
  if (signature !== lastTocSignature) {
    renderTocList();
    return;
  }
  updateTocHighlight();
}

function getActiveHeadingFromPreview(): string | null {
  const headings = preview.querySelectorAll<HTMLElement>(
    "h1[id^='heading-'], h2[id^='heading-'], h3[id^='heading-'], h4[id^='heading-'], h5[id^='heading-'], h6[id^='heading-']"
  );
  if (headings.length === 0) return null;

  const viewportTop = preview.getBoundingClientRect().top + 8;
  let active: string | null = null;

  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= viewportTop) {
      active = heading.id;
    } else {
      break;
    }
  }

  return active ?? headings[0].id;
}

function getActiveHeadingFromEditor(): string | null {
  const headings = extractHeadings(editor.value);
  if (headings.length === 0) return null;

  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  const topLine = Math.floor(editor.scrollTop / lineHeight);
  let active: string | null = null;

  for (const heading of headings) {
    if (heading.line <= topLine) {
      active = heading.id;
    } else {
      break;
    }
  }

  return active ?? headings[0].id;
}

function resolveActiveHeadingId(): string | null {
  if (currentViewMode === "edit") {
    return getActiveHeadingFromEditor();
  }
  return getActiveHeadingFromPreview();
}

function setActiveTocItem(id: string | null) {
  if (activeTocId === id) return;
  activeTocId = id;

  const list = $("#sidebar-toc-list");
  list.querySelectorAll(".sidebar-toc-item").forEach((item) => {
    const el = item as HTMLElement;
    el.classList.toggle("active", el.dataset.id === id);
  });

  if (!id) return;

  const activeEl = list.querySelector(
    `.sidebar-toc-item[data-id="${CSS.escape(id)}"]`
  );
  if (!activeEl) return;

  const listRect = list.getBoundingClientRect();
  const elRect = activeEl.getBoundingClientRect();
  if (elRect.top < listRect.top || elRect.bottom > listRect.bottom) {
    activeEl.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
}

function updateTocHighlight() {
  if (sidebarTab !== "toc") return;
  if ($("#sidebar-toc-list").querySelector(".sidebar-toc-item") === null) return;
  setActiveTocItem(resolveActiveHeadingId());
}

function scheduleTocHighlightUpdate() {
  if (sidebarTab !== "toc") return;
  if (tocHighlightRaf !== null) cancelAnimationFrame(tocHighlightRaf);
  tocHighlightRaf = requestAnimationFrame(() => {
    tocHighlightRaf = null;
    updateTocHighlight();
  });
}

function setSidebarTab(tab: SidebarTab) {
  tab = resolveSidebarTab(tab);
  sidebarTab = tab;

  $("#sidebar-tab-files").classList.toggle("active", tab === "files");
  $("#sidebar-tab-toc").classList.toggle("active", tab === "toc");

  if (isDocumentsPanelEnabled()) {
    $("#sidebar-file-panel").classList.toggle("hidden", tab !== "files");
    $("#sidebar-toc-list").classList.toggle("hidden", tab !== "toc");
  } else {
    $("#sidebar-file-panel").classList.add("hidden");
    $("#sidebar-toc-list").classList.remove("hidden");
  }

  if (tab === "files") {
    void refreshFileList();
  } else {
    renderTocList();
  }
}

function scrollEditorToLine(lineIndex: number) {
  const lines = editor.value.split("\n");
  let pos = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    pos += lines[i].length + 1;
  }

  editor.focus();
  editor.setSelectionRange(pos, pos);

  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  editor.scrollTop = Math.max(0, lineIndex * lineHeight - editor.clientHeight * 0.25);
}

function scrollToHeading(id: string, lineIndex: number) {
  if (currentViewMode !== "edit") {
    const target = preview.querySelector(`#${CSS.escape(id)}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }

  scrollEditorToLine(lineIndex);
}

async function refreshSidebar() {
  if (sidebarTab === "files") {
    await refreshFileList();
    return;
  }

  renderPreview(true);
}

// ── Preview update (debounced) ─────────────────────────
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewRenderGeneration = 0;
let mermaidRunChain: Promise<void> = Promise.resolve();
let mermaidThemeKey: string | null = null;

function updateMermaidTheme() {
  const themeKey = isDark ? "dark" : "light";
  if (mermaidThemeKey === themeKey) return;

  mermaidThemeKey = themeKey;
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "default",
    securityLevel: "loose",
  });
}

async function renderMermaidInPreview(
  container: HTMLElement,
  generation: number
) {
  if (generation !== previewRenderGeneration) return;

  const nodes = container.querySelectorAll<HTMLElement>(".mermaid");
  if (nodes.length === 0) return;

  updateMermaidTheme();
  const themeKey = mermaidThemeKey ?? (isDark ? "dark" : "light");
  const nodesToRun: HTMLElement[] = [];

  nodes.forEach((node) => {
    if (
      node.hasAttribute("data-processed") &&
      node.getAttribute("data-mermaid-theme") === themeKey
    ) {
      return;
    }
    node.removeAttribute("data-processed");
    nodesToRun.push(node);
  });

  if (nodesToRun.length === 0) return;

  try {
    await mermaid.run({ nodes: nodesToRun, suppressErrors: true });
    nodesToRun.forEach((node) => {
      node.setAttribute("data-mermaid-theme", themeKey);
    });
  } catch (error) {
    console.error("Mermaid 渲染失败:", error);
  }
}

function parsePreviewHtml(markdown: string): string {
  previewMermaidBlockIndex = 0;
  return addHeadingIds(marked.parse(markdown) as string);
}

function renderPreview(immediate = false) {
  const run = async () => {
    const generation = ++previewRenderGeneration;
    const syncRatio =
      scrollSyncLocked && currentViewMode === "split"
        ? getScrollRatio(editor)
        : null;
    const preservePreviewScroll =
      currentViewMode === "split" && !scrollSyncLocked;
    const previewScrollRatio = preservePreviewScroll
      ? getScrollRatio(preview)
      : null;
    const useEditorScrollSync =
      scrollSyncLocked && currentViewMode === "split";

    scrollSyncSuspended = true;
    try {
      const html = parsePreviewHtml(editor.value);
      const mermaidThemeKey = isDark ? "dark" : "light";
      morphPreviewHtml(preview, html, mermaidThemeKey);
      mermaidRunChain = mermaidRunChain
        .then(() => renderMermaidInPreview(preview, generation))
        .catch((error) => {
          console.error("Mermaid 预览队列失败:", error);
        });
      await mermaidRunChain;

      if (generation !== previewRenderGeneration) return;
    } finally {
      scrollSyncSuspended = false;
    }

    if (useEditorScrollSync) {
      markScrollSyncSource("editor");
      setScrollByRatio(preview, syncRatio ?? getScrollRatio(editor));
    } else if (previewScrollRatio !== null) {
      setScrollByRatio(preview, previewScrollRatio);
    }

    if (sidebarTab === "toc") {
      renderTocListIfNeeded();
    } else {
      scheduleTocHighlightUpdate();
    }

    updateStatus();
  };

  if (immediate) {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    void run();
    return;
  }

  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void run(), 100);
}

function updatePreview() {
  if (currentViewMode === "edit") return;
  renderPreview(false);
}

// ── Status bar ─────────────────────────────────────────
function updateStatus() {
  const text = editor.value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text.split(/\n/).length;
  statusWords.textContent = `${words} ${t("status.words")}`;
  statusChars.textContent = `${chars} ${t("status.chars")}`;
  statusLines.textContent = `${lines} ${t("status.lines")}`;

  const cursorPos = editor.selectionStart;
  const textBefore = text.substring(0, cursorPos);
  const line = textBefore.split("\n").length;
  const lastNewline = textBefore.lastIndexOf("\n");
  const col = cursorPos - lastNewline;
  statusCursor.textContent = t("status.cursor", { line, col });
}

// ── Title update ───────────────────────────────────────
function extractDocumentTitle(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = line.match(/^#\s+(.+)$/);
    if (!match) continue;

    const title = match[1].trim().replace(/\s+#+\s*$/, "");
    if (title) return title;
  }

  return null;
}

function getToolbarDocumentTitle(): string {
  const headingTitle = extractDocumentTitle(editor.value);
  if (headingTitle) return headingTitle;

  if (currentFilePath) {
    return currentFilePath.split(/[/\\]/).pop() || t("status.unnamed");
  }

  return t("status.unnamed");
}

type FileSaveState = "saved" | "modified" | "new";

function getFileStatusLabel(state: FileSaveState): string {
  if (state === "saved") return t("fileStatus.saved");
  if (state === "modified") return t("fileStatus.modified");
  return t("fileStatus.new");
}

function getFileSaveState(): FileSaveState {
  if (!currentFilePath) return "new";
  if (isModified) return "modified";
  return "saved";
}

function updateToolbarDocumentTitle() {
  const title = getToolbarDocumentTitle();
  const fileNameEl = $("#file-name");
  fileNameEl.textContent = title;
  fileNameEl.title = title;

  const state = getFileSaveState();
  const dot = $("#file-status-dot");
  dot.dataset.state = state;
  dot.title = getFileStatusLabel(state);
}

function getWindowTitle(): string {
  const fileLabel = currentFilePath
    ? currentFilePath.split(/[/\\]/).pop() || t("status.unnamed")
    : t("status.unnamed");
  return (isModified ? "* " : "") + fileLabel + " - " + t("app.title");
}

function updateTitle() {
  const windowTitle = getWindowTitle();
  document.title = windowTitle;
  statusFilePath.textContent = currentFilePath || "";
  updateToolbarDocumentTitle();

  void appWindow.setTitle(windowTitle).catch((err) => {
    console.error("设置窗口标题失败:", err);
  });
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
  document.documentElement.dataset.sidebar = sidebarVisible ? "open" : "closed";
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
      title: t("dialog.openFolder"),
    });
    if (folderPath && typeof folderPath === "string") {
      currentFolderPath = folderPath;
      await refreshFileList();
    }
  } catch (e) {
    console.error("打开文件夹失败:", e);
  }
}

function getParentDir(filePath: string): string {
  return filePath.replace(/[/\\][^/\\]+$/, "");
}

async function recordDocumentHistory(path: string) {
  const next = addToDocumentHistory(documentHistory, path);
  if (next.length === documentHistory.length && next[0] === documentHistory[0]) {
    return;
  }
  documentHistory = next;
  try {
    await saveDocumentHistory(documentHistory);
  } catch (e) {
    console.error("保存文档历史失败:", e);
  }
}

async function removeDocumentHistoryItem(path: string) {
  documentHistory = removeFromDocumentHistoryList(documentHistory, path);
  try {
    await saveDocumentHistory(documentHistory);
  } catch (e) {
    console.error("保存文档历史失败:", e);
  }
}

function renderSidebarFilesInto(
  list: HTMLElement,
  files: string[],
  isHistory: boolean
) {
  if (files.length === 0) {
    const message = isHistory
      ? t("sidebar.noHistory")
      : currentFilePath
        ? t("sidebar.noMarkdown")
        : t("sidebar.openFolderHint");
    const icon = isHistory ? "fa-clock-rotate-left" : "fa-folder-open";
    renderFileListEmpty(list, message, icon);
    return;
  }

  list.innerHTML = files
    .map((f) => {
      const name = f.split(/[/\\]/).pop() || f;
      const safePath = f.replace(/"/g, "&quot;");
      const isActive = f === currentFilePath;
      const historyClass = isHistory ? " sidebar-file-history" : "";
      const removeBtn = isHistory
        ? `<button type="button" class="sidebar-file-remove" title="${t("sidebar.removeHistoryItem")}" aria-label="${t("sidebar.removeHistoryItem")}"><i class="fa-solid fa-xmark"></i></button>`
        : "";

      return `<div class="sidebar-file${historyClass}${isActive ? " active" : ""}" data-path="${safePath}" title="${safePath}">
          <i class="fa-solid fa-file-lines shrink-0"></i><span class="truncate">${escapeHtml(name)}</span>${removeBtn}
        </div>`;
    })
    .join("");

  list.querySelectorAll(".sidebar-file").forEach((item) => {
    item.addEventListener("click", async (e) => {
      if ((e.target as HTMLElement).closest(".sidebar-file-remove")) return;
      const path = (item as HTMLElement).dataset.path!;
      await openFileByPath(path);
    });
  });

  if (isHistory) {
    list.querySelectorAll(".sidebar-file-remove").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const path = (btn.closest(".sidebar-file") as HTMLElement).dataset.path!;
        await removeDocumentHistoryItem(path);
        await refreshFileList();
      });
    });
  }
}

async function getSiblingDocumentPaths(): Promise<string[]> {
  if (currentFilePath) {
    const parentDir = getParentDir(currentFilePath);
    try {
      return await invoke<string[]>("list_md_files", { dir: parentDir });
    } catch (e) {
      console.error("列出兄弟文档失败:", e);
      return [];
    }
  }

  if (currentFolderPath) {
    try {
      return await invoke<string[]>("list_md_files", {
        dir: currentFolderPath,
      });
    } catch (e) {
      console.error("列出文件失败:", e);
      return [];
    }
  }

  return [];
}

function updateSidebarFolderLabel() {
  const folderLabel = $("#sidebar-folder-path");
  const parts: string[] = [];

  if (appSettings.showSiblingDocuments) {
    if (currentFilePath) {
      const parentDir = getParentDir(currentFilePath);
      parts.push(parentDir.split(/[/\\]/).pop() || parentDir);
      folderLabel.title = parentDir;
    } else if (currentFolderPath) {
      parts.push(
        currentFolderPath.split(/[/\\]/).pop() || currentFolderPath
      );
      folderLabel.title = currentFolderPath;
    }
  }

  if (
    appSettings.showHistoryDocuments &&
    documentHistory.length > 0 &&
    !parts.includes(t("sidebar.recentFiles"))
  ) {
    parts.push(t("sidebar.recentFiles"));
  }

  folderLabel.textContent = parts.join(" · ");
  if (parts.length === 0) {
    folderLabel.removeAttribute("title");
  }
}

async function refreshFileList() {
  if (!isDocumentsPanelEnabled()) {
    updateSidebarFolderLabel();
    return;
  }

  if (appSettings.showSiblingDocuments) {
    const siblings = await getSiblingDocumentPaths();
    renderSidebarFilesInto($("#sidebar-siblings-list"), siblings, false);
  }

  if (appSettings.showHistoryDocuments) {
    renderSidebarFilesInto(
      $("#sidebar-history-list"),
      [...documentHistory],
      true
    );
  }

  updateSidebarFolderLabel();
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
    await recordDocumentHistory(path);
    await refreshFileList();
    return true;
  } catch (e) {
    alert(`打开文件失败: ${e}`);
    return false;
  }
}

async function pickFirstOpenablePath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      if (await invoke<boolean>("is_regular_file", { path })) {
        return path;
      }
    } catch {
      // ignore invalid paths
    }
  }
  return null;
}

async function openPathsFromSystem(paths: string[]): Promise<boolean> {
  const filePath = await pickFirstOpenablePath(paths);
  if (!filePath) return false;

  const opened = await openFileByPath(filePath);
  if (!opened) return false;

  const parent = getParentDir(filePath);
  if (parent) {
    currentFolderPath = parent;
  }
  return true;
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

function insertMarkdownAtCursor(markdown: string) {
  const el = editor;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const before = el.value.substring(0, start);
  const after = el.value.substring(end);
  const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
  const insertion = `${needsLeadingNewline ? "\n" : ""}${markdown}\n`;
  el.value = before + insertion + after;
  const cursor = before.length + insertion.length;
  el.selectionStart = cursor;
  el.selectionEnd = cursor;
  el.focus();
  markModified();
  updatePreview();
}

async function uploadDroppedAttachments(paths: string[]) {
  for (const path of paths) {
    const name = path.split(/[/\\]/).pop() || path;
    showToast(t("toast.attachmentUploading", { name }));
    try {
      const url = await resolveAttachmentLink(path, appSettings.attachmentLinkScript);
      insertMarkdownAtCursor(buildAttachmentMarkdown(name, url));
      showToast(t("toast.attachmentUploaded", { name }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      showToast(t("toast.attachmentUploadFailed", { error }));
      console.error("附件上传失败:", e);
    }
  }
}

async function handleExternalFileDrop(paths: string[]) {
  const regularFiles: string[] = [];
  for (const path of paths) {
    try {
      if (await invoke<boolean>("is_regular_file", { path })) {
        regularFiles.push(path);
      }
    } catch {
      /* ignore invalid paths */
    }
  }

  if (regularFiles.length === 0) {
    showToast("请拖入可打开的文件");
    return;
  }

  if (appSettings.attachmentUploadEnabled) {
    const attachmentPaths = regularFiles.filter((path) => !isMarkdownFilePath(path));
    const markdownPaths = regularFiles.filter((path) => isMarkdownFilePath(path));

    if (attachmentPaths.length > 0) {
      await uploadDroppedAttachments(attachmentPaths);
    }

    if (markdownPaths.length > 0) {
      const opened = await openFileByPath(markdownPaths[0]);
      if (opened) {
        const name = markdownPaths[0].split(/[/\\]/).pop() || markdownPaths[0];
        showToast(`已打开 ${name}`);
      }
    }
    return;
  }

  const filePath = regularFiles[0];
  const opened = await openFileByPath(filePath);
  if (opened) {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    showToast(`已打开 ${name}`);
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
  await refreshFileList();
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
      showToast(t("toast.saved"));
      await refreshFileList();
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
      showToast(t("toast.savedAs"));
      await recordDocumentHistory(path);
      await refreshFileList();
    }
  } catch (e) {
    alert(`另存失败: ${e}`);
  }
}

// ── View Mode ──────────────────────────────────────────
function setViewMode(mode: ViewMode) {
  currentViewMode = mode;
  document.documentElement.dataset.viewMode = mode;
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
      renderPreview(true);
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

  if (mode === "split" && scrollSyncLocked) {
    requestAnimationFrame(() => {
      applyScrollSync("editor");
      scheduleTocHighlightUpdate();
    });
  } else {
    scheduleTocHighlightUpdate();
  }
}

// ── Theme ──────────────────────────────────────────────
function applyTheme(theme: "light" | "dark", options?: { updatePreview?: boolean }) {
  isDark = theme === "dark";
  const html = document.documentElement;
  const icon = $("#btn-theme").querySelector("i")!;
  if (isDark) {
    html.classList.add("dark");
    icon.className = "fa-solid fa-sun";
    $("#btn-theme").title = t("toolbar.themeDark");
  } else {
    html.classList.remove("dark");
    icon.className = "fa-solid fa-moon";
    $("#btn-theme").title = t("toolbar.themeLight");
  }
  if (options?.updatePreview !== false) {
    renderPreview(true);
  }
}

function toggleTheme() {
  const nextTheme = isDark ? "light" : "dark";
  applyTheme(nextTheme);
  appSettings = { ...appSettings, theme: nextTheme };
  void saveAppSettings(appSettings);
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
  mathinline: { prefix: "$", suffix: "$", defaultText: "E=mc^2" },
  mathblock: {
    prefix: "\\begin{equation}\n",
    suffix: "\n\\end{equation}",
    defaultText: "E=mc^2",
    multiline: true,
  },
  mermaid: {
    prefix: "```mermaid\n",
    suffix: "\n```",
    defaultText: "graph TD\n    A[开始] --> B[结束]",
    multiline: true,
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
  updateToolbarDocumentTitle();
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
$("#sidebar-tab-files")?.addEventListener("click", () => setSidebarTab("files"));
$("#sidebar-tab-toc")?.addEventListener("click", () => setSidebarTab("toc"));
$("#btn-refresh-sidebar")?.addEventListener("click", () => {
  void refreshSidebar();
});

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

let sidebarFilesSplitterDragging = false;

function initSidebarFilesSplitter() {
  const splitter = $("#sidebar-files-splitter");
  const container = $("#sidebar-file-panel");

  splitter.addEventListener("mousedown", (e) => {
    if (splitter.classList.contains("hidden")) return;
    e.preventDefault();
    sidebarFilesSplitterDragging = true;
    splitter.classList.add("is-dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!sidebarFilesSplitterDragging) return;
    const rect = container.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pct = Math.max(0.2, Math.min(0.8, y / rect.height));
    applyDocumentListSplitRatio(pct);
  });

  document.addEventListener("mouseup", () => {
    if (!sidebarFilesSplitterDragging) return;
    sidebarFilesSplitterDragging = false;
    splitter.classList.remove("is-dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    void persistSettings({
      documentListSplitRatio: appSettings.documentListSplitRatio,
    });
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

      await handleExternalFileDrop(payload.paths);
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
  }, 120);
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
  return scrollSyncLocked && currentViewMode === "split" && !scrollSyncSuspended;
}

/** 光标在左侧编辑器内时，滚动同步仅 Editor → Preview */
function isEditorDrivingScrollSync(): boolean {
  return document.activeElement === editor;
}

function updateScrollLockButton() {
  const btn = $("#btn-scroll-lock");
  const icon = btn.querySelector("i");
  if (!icon) return;

  if (scrollSyncLocked) {
    btn.classList.add("active");
    btn.title = t("toolbar.scrollUnlock");
    icon.className = "fa-solid fa-lock";
  } else {
    btn.classList.remove("active");
    btn.title = t("toolbar.scrollLock");
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
  showToast(scrollSyncLocked ? t("toast.scrollLocked") : t("toast.scrollUnlocked"));
}

function initSyncScroll() {
  editor.addEventListener("focus", () => {
    if (shouldSyncScroll()) {
      applyScrollSync("editor");
    }
  });

  preview.addEventListener("mousedown", () => {
    editor.blur();
  });

  editor.addEventListener("scroll", () => {
    scheduleTocHighlightUpdate();
    if (!shouldSyncScroll() || scrollSyncSource === "preview") return;
    applyScrollSync("editor");
  });

  preview.addEventListener("scroll", () => {
    scheduleTocHighlightUpdate();
    if (!shouldSyncScroll() || scrollSyncSource === "editor") return;
    if (isEditorDrivingScrollSync()) return;
    applyScrollSync("preview");
  });

  updateScrollLockButton();
}

// ── Settings modal ─────────────────────────────────────
type SettingsPanel = "general" | "attachments" | "appearance" | "system";

function getWelcomeContent(): string {
  if (getLanguage() === "en") {
    return `# Welcome to MD Editor

A lightweight **Markdown editor** built with Tauri and Tailwind CSS.

## Features

- 🚀 **Fast & light** — native desktop app with Tauri
- 📝 **Live preview** — edit and preview in sync
- 📂 **Folder browser** — open a folder from the toolbar
- 🎨 **Syntax highlighting** — GFM tables and task lists
- 🌙 **Dark mode** — toggle with the sun/moon button
- ⌨️ **Shortcuts** — \`Ctrl+B\` bold, \`Ctrl+S\` save

## Quick start

1. Click **Open file** or **Open folder** in the toolbar
2. Start writing Markdown
3. Press \`Ctrl+S\` to save

> Tip: click the ☰ button to expand the sidebar

\`\`\`javascript
function hello() {
  console.log("Hello, MD Editor!");
}
\`\`\`

| Action | Shortcut |
|--------|----------|
| Bold | Ctrl+B |
| Italic | Ctrl+I |
| Save | Ctrl+S |
| Open | Ctrl+O |
| New | Ctrl+N |
`;
  }

  return `# 欢迎使用 MD Editor

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
}

function applyToolbarI18n() {
  const map: Record<string, string> = {
    "#btn-sidebar-toggle": "toolbar.sidebar",
    "#btn-open-folder": "toolbar.openFolder",
    "#btn-settings": "toolbar.settings",
    "#btn-new": "toolbar.new",
    "#btn-open": "toolbar.open",
    "#btn-save": "toolbar.save",
    "#btn-save-as": "toolbar.saveAs",
    "#btn-view-edit": "toolbar.viewEdit",
    "#btn-view-split": "toolbar.viewSplit",
    "#btn-view-preview": "toolbar.viewPreview",
    "#sidebar-tab-files": "sidebar.tabFiles",
    "#sidebar-tab-toc": "sidebar.tabToc",
    "#btn-refresh-sidebar": "sidebar.refresh",
  };

  for (const [selector, key] of Object.entries(map)) {
    const el = document.querySelector(selector);
    if (el) el.setAttribute("title", t(key));
  }

  const formatTitles: Record<string, string> = {
    bold: "toolbar.bold",
    italic: "toolbar.italic",
    strikethrough: "toolbar.strikethrough",
    heading1: "toolbar.heading1",
    heading2: "toolbar.heading2",
    heading3: "toolbar.heading3",
    ul: "toolbar.ul",
    ol: "toolbar.ol",
    task: "toolbar.task",
    quote: "toolbar.quote",
    code: "toolbar.code",
    codeblock: "toolbar.codeblock",
    link: "toolbar.link",
    image: "toolbar.image",
    hr: "toolbar.hr",
    table: "toolbar.table",
  };

  document.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.getAttribute("data-action");
    if (!action || !formatTitles[action]) return;
    el.setAttribute("title", t(formatTitles[action]));
  });

  updateScrollLockButton();
  applyTheme(appSettings.theme);
}

async function applyLanguageSetting(language: Language) {
  setLanguage(language);
  applyI18nToDom();
  applyToolbarI18n();
  updateStatus();
  updateToolbarDocumentTitle();
  updateTitle();
  await updateSettingsDefaultStatus();

  if (!currentFilePath && !isModified) {
    editor.value = getWelcomeContent();
    updatePreview();
  }

  await refreshFileList();
}

async function applyAppSettings(settings: AppSettings, options?: { startup?: boolean }) {
  appSettings = settings;
  syncBootstrapSettingsToDocument(settings);

  await applyLanguageSetting(settings.language);
  applyTheme(settings.theme, { updatePreview: !options?.startup });

  if (options?.startup) {
    sidebarVisible = settings.defaultSidebarVisible;
    scrollSyncLocked = settings.defaultScrollSyncLocked;
    applySidebarState();
    setViewMode(settings.defaultViewMode);
    updateSidebarDocumentsVisibility();
    setSidebarTab(resolveSidebarTab(settings.defaultSidebarTab));
    await refreshFileList();
  }

  updateScrollLockButton();
}

function syncSettingsFormFromState() {
  const viewInput = document.querySelector<HTMLInputElement>(
    `input[name="setting-view-mode"][value="${appSettings.defaultViewMode}"]`
  );
  if (viewInput) viewInput.checked = true;

  const langInput = document.querySelector<HTMLInputElement>(
    `input[name="setting-language"][value="${appSettings.language}"]`
  );
  if (langInput) langInput.checked = true;

  const themeInput = document.querySelector<HTMLInputElement>(
    `input[name="setting-theme"][value="${appSettings.theme}"]`
  );
  if (themeInput) themeInput.checked = true;

  const scrollLock = $<HTMLInputElement>("#setting-scroll-lock");
  scrollLock.checked = appSettings.defaultScrollSyncLocked;

  const sidebar = $<HTMLInputElement>("#setting-sidebar-visible");
  sidebar.checked = appSettings.defaultSidebarVisible;

  const tabInput = document.querySelector<HTMLInputElement>(
    `input[name="setting-sidebar-tab"][value="${appSettings.defaultSidebarTab}"]`
  );
  if (tabInput) tabInput.checked = true;

  $<HTMLInputElement>("#setting-show-siblings").checked =
    appSettings.showSiblingDocuments;
  $<HTMLInputElement>("#setting-show-history").checked =
    appSettings.showHistoryDocuments;

  $<HTMLInputElement>("#setting-attachment-upload-enabled").checked =
    appSettings.attachmentUploadEnabled;
  $<HTMLTextAreaElement>("#setting-attachment-link-script").value =
    appSettings.attachmentLinkScript;
  updateAttachmentSettingsVisibility();
}

function readAttachmentSettingsFromForm(): Pick<
  AppSettings,
  "attachmentUploadEnabled" | "attachmentLinkScript"
> {
  return {
    attachmentUploadEnabled: $<HTMLInputElement>(
      "#setting-attachment-upload-enabled"
    ).checked,
    attachmentLinkScript: $<HTMLTextAreaElement>(
      "#setting-attachment-link-script"
    ).value,
  };
}

function updateAttachmentSettingsVisibility() {
  const enabled = appSettings.attachmentUploadEnabled;
  $("#settings-attachment-fields")?.classList.toggle("hidden", !enabled);
}

async function persistAttachmentSettingsFromForm() {
  await persistSettings(readAttachmentSettingsFromForm());
  updateAttachmentSettingsVisibility();
}

async function persistSettings(patch: Partial<AppSettings>) {
  appSettings = { ...appSettings, ...patch };
  try {
    await saveAppSettings(appSettings);
  } catch (e) {
    console.error("保存设置失败:", e);
    alert(`保存设置失败: ${e}`);
  }
}

function onDocumentListSettingsChanged() {
  const showSiblingDocuments = $<HTMLInputElement>("#setting-show-siblings").checked;
  const showHistoryDocuments = $<HTMLInputElement>("#setting-show-history").checked;
  const docsWereDisabled = !isDocumentsPanelEnabled();

  void persistSettings({ showSiblingDocuments, showHistoryDocuments });
  updateSidebarDocumentsVisibility();

  if (!isDocumentsPanelEnabled()) {
    setSidebarTab("toc");
  } else if (docsWereDisabled) {
    setSidebarTab(resolveSidebarTab(appSettings.defaultSidebarTab));
  } else {
    setSidebarTab(resolveSidebarTab(sidebarTab));
  }

  void refreshFileList();
}

function setSettingsPanel(panel: SettingsPanel) {
  document.querySelectorAll(".settings-nav-item").forEach((item) => {
    item.classList.toggle(
      "active",
      item.getAttribute("data-settings-panel") === panel
    );
  });

  document.querySelectorAll(".settings-panel").forEach((section) => {
    const id = section.id.replace("settings-panel-", "");
    section.classList.toggle("active", id === panel);
    section.classList.toggle("hidden", id !== panel);
  });
}

async function updateSettingsDefaultStatus() {
  const status = $("#settings-default-status");
  const btn = $<HTMLButtonElement>("#settings-btn-default-app");
  if (!status || !btn) return;
  btn.disabled = false;
  try {
    const isDefault = await invoke<boolean>("is_md_default_handler");
    if (isDefault) {
      status.textContent = t("settings.fileAssoc.isDefault");
      btn.textContent = t("settings.fileAssoc.reRegister");
      btn.classList.add("active");
    } else {
      status.textContent = t("settings.fileAssoc.notDefault");
      btn.textContent = t("settings.fileAssoc.register");
      btn.classList.remove("active");
    }
  } catch {
    status.textContent = t("settings.fileAssoc.windowsOnly");
    btn.disabled = true;
  }
}

function openSettings() {
  const modal = $("#settings-modal");
  modal.classList.remove("hidden");
  modal.classList.add("open");
  syncSettingsFormFromState();
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
    showToast(t("toast.defaultApp"));
    await updateSettingsDefaultStatus();
  } catch (e) {
    alert(`设置失败: ${e}`);
  }
}

function initSettings() {
  $("#btn-settings")?.addEventListener("click", openSettings);
  $("#settings-close")?.addEventListener("click", closeSettings);
  $("#settings-btn-default-app")?.addEventListener(
    "click",
    registerDefaultAppFromSettings
  );

  document.querySelectorAll(".settings-nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      const panel = item.getAttribute("data-settings-panel") as SettingsPanel;
      setSettingsPanel(panel);
    });
  });

  document
    .querySelectorAll<HTMLInputElement>("input[name='setting-view-mode']")
    .forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const mode = input.value as ViewMode;
        void persistSettings({ defaultViewMode: mode });
        setViewMode(mode);
      });
    });

  $<HTMLInputElement>("#setting-scroll-lock")?.addEventListener("change", (e) => {
    const locked = (e.target as HTMLInputElement).checked;
    void persistSettings({ defaultScrollSyncLocked: locked });
    scrollSyncLocked = locked;
    updateScrollLockButton();
    if (locked && currentViewMode === "split") {
      applyScrollSync("editor");
    }
  });

  $<HTMLInputElement>("#setting-sidebar-visible")?.addEventListener(
    "change",
    (e) => {
      const visible = (e.target as HTMLInputElement).checked;
      void persistSettings({ defaultSidebarVisible: visible });
      sidebarVisible = visible;
      applySidebarState();
    }
  );

  document
    .querySelectorAll<HTMLInputElement>("input[name='setting-sidebar-tab']")
    .forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const tab = input.value as SidebarTab;
        void persistSettings({ defaultSidebarTab: tab });
        setSidebarTab(tab);
      });
    });

  $<HTMLInputElement>("#setting-show-siblings")?.addEventListener("change", () => {
    onDocumentListSettingsChanged();
  });

  $<HTMLInputElement>("#setting-show-history")?.addEventListener("change", () => {
    onDocumentListSettingsChanged();
  });

  document
    .querySelectorAll<HTMLInputElement>("input[name='setting-language']")
    .forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const language = input.value as Language;
        void persistSettings({ language });
        void applyLanguageSetting(language);
      });
    });

  document
    .querySelectorAll<HTMLInputElement>("input[name='setting-theme']")
    .forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const theme = input.value as AppSettings["theme"];
        void persistSettings({ theme });
        applyTheme(theme);
      });
    });

  $<HTMLInputElement>("#setting-attachment-upload-enabled")?.addEventListener(
    "change",
    () => {
      void persistAttachmentSettingsFromForm();
    }
  );

  $("#setting-attachment-link-script")?.addEventListener("change", () => {
    void persistAttachmentSettingsFromForm();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#settings-modal").classList.contains("open")) {
      closeSettings();
    }
  });
}

// ── Default app / system file open ─────────────────────
let appReadyForOpenFiles = false;
const pendingOpenFilePaths: string[] = [];

void listen<string[]>("open-files", async (event) => {
  const paths = event.payload ?? [];
  if (!paths.length) return;

  if (!appReadyForOpenFiles) {
    pendingOpenFilePaths.push(...paths);
    return;
  }

  await openPathsFromSystem(paths);
});

async function tryOpenLaunchFiles(): Promise<boolean> {
  if (await openLaunchFiles()) return true;

  // macOS may deliver RunEvent::Opened shortly after the first take_launch_files call.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (await openLaunchFiles()) return true;
  }

  return false;
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

  try {
    appSettings = await loadAppSettings();
    documentHistory = await loadDocumentHistory();
    await applyAppSettings(appSettings, { startup: true });

    initSplitter();
    initSidebarFilesSplitter();
    initDragDrop();
    initSyncScroll();
    initSettings();
    initToolbarLayout();

    let openedFromLaunch = await tryOpenLaunchFiles();
    if (!openedFromLaunch && pendingOpenFilePaths.length > 0) {
      openedFromLaunch = await openPathsFromSystem([...pendingOpenFilePaths]);
      pendingOpenFilePaths.length = 0;
    }

    appReadyForOpenFiles = true;

    if (!openedFromLaunch) {
      editor.value = getWelcomeContent();
      updatePreview();
    }

    updateStatus();
    updateTitle();
  } finally {
    markAppReady();
  }
});

// Handle beforeunload
window.addEventListener("beforeunload", (e) => {
  if (isModified) {
    e.preventDefault();
  }
});

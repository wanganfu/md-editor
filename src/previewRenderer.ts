import { convertFileSrc } from "@tauri-apps/api/core";
import { Idiomorph } from "idiomorph";
import {
  findDirtyBlockIndices,
  splitMarkdownIntoBlocks,
  type MarkdownBlock,
} from "./markdownBlocks";
import {
  addHeadingIds,
  rewriteLocalResourceUrls,
  resolveResourcePath,
} from "./markdownPipeline";
import { MermaidLazyRenderer } from "./mermaidLazy";
import PreviewWorker from "./workers/previewWorker?worker";
import { adjustOrderedListMarkers } from "./orderedListLayout";

const REMOTE_URL_RE =
  /^(https?:|\/\/|data:|mailto:|javascript:|#|asset:|blob:|https:\/\/asset\.)/i;

const FAST_DEBOUNCE_MS = 80;
const MERMAID_DEBOUNCE_MS = 400;

function isLocalAbsolutePath(path: string): boolean {
  return (
    /^[a-zA-Z]:[/\\]/.test(path) ||
    (path.startsWith("/") && !path.startsWith("//"))
  );
}

function countHeadingsInHtml(html: string): number {
  const matches = html.match(/<h[1-6](?:\s|>)/gi);
  return matches ? matches.length : 0;
}

function convertAssetUrls(html: string): string {
  const convert = (url: string) => {
    if (!url || REMOTE_URL_RE.test(url)) return url;
    if (!isLocalAbsolutePath(url)) return url;
    try {
      return convertFileSrc(url);
    } catch {
      return url;
    }
  };

  return html
    .replace(
      /(<a\b[^>]*?\shref=)(["'])(?!#)([^"']+)\2/gi,
      (_match, prefix, quote, href) =>
        `${prefix}${quote}${convert(href)}${quote}`
    )
    .replace(
      /(<img\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi,
      (_match, prefix, quote, src) =>
        `${prefix}${quote}${convert(src)}${quote}`
    )
    .replace(
      /(<(?:video|audio|source)\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi,
      (_match, prefix, quote, src) =>
        `${prefix}${quote}${convert(src)}${quote}`
    );
}

function finalizeBlockHtml(html: string, baseDir: string | null): string {
  const withPaths = rewriteLocalResourceUrls(html, baseDir);
  return baseDir ? convertAssetUrls(withPaths) : withPaths;
}

function morphBlockElement(
  element: HTMLElement,
  html: string,
  mermaidThemeKey: string
): void {
  Idiomorph.morph(element, html, {
    morphStyle: "innerHTML",
    callbacks: {
      beforeNodeMorphed(oldNode, newNode) {
        if (!(oldNode instanceof HTMLElement && newNode instanceof HTMLElement)) {
          return;
        }
        if (!oldNode.classList.contains("mermaid")) return;

        const oldKey = oldNode.getAttribute("data-mermaid-key");
        const newKey = newNode.getAttribute("data-mermaid-key");
        const oldTheme = oldNode.getAttribute("data-mermaid-theme");

        if (
          oldNode.hasAttribute("data-processed") &&
          oldKey &&
          oldKey === newKey &&
          oldTheme === mermaidThemeKey
        ) {
          return false;
        }
      },
    },
  });
}

export type PreviewRendererOptions = {
  preview: HTMLElement;
  getResourceBaseDir: () => string | null;
  getIsDark: () => boolean;
  onAfterRender?: () => void;
};

export type PreviewRenderOptions = {
  immediate?: boolean;
  force?: boolean;
  resetScroll?: boolean;
};

export class PreviewRenderer {
  private readonly preview: HTMLElement;
  private readonly getResourceBaseDir: () => string | null;
  private readonly getIsDark: () => boolean;
  private readonly onAfterRender?: () => void;
  private readonly worker: Worker;
  private readonly mermaidLazy: MermaidLazyRenderer;

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private mermaidTimer: ReturnType<typeof setTimeout> | null = null;
  private renderGeneration = 0;
  private workerRequestId = 0;
  private pendingWorkerRequest = 0;

  /** Parsed HTML per block content hash (before heading ids) */
  private blockHashCache = new Map<string, string>();
  private lastBlockHashes: string[] = [];
  private lastBlocks: MarkdownBlock[] = [];

  constructor(options: PreviewRendererOptions) {
    this.preview = options.preview;
    this.getResourceBaseDir = options.getResourceBaseDir;
    this.getIsDark = options.getIsDark;
    this.onAfterRender = options.onAfterRender;
    this.worker = new PreviewWorker();
    this.mermaidLazy = new MermaidLazyRenderer({ getIsDark: this.getIsDark });

    this.worker.onmessage = (event) => {
      this.handleWorkerResponse(event.data);
    };
  }

  destroy(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.mermaidTimer) clearTimeout(this.mermaidTimer);
    this.worker.terminate();
    this.mermaidLazy.destroy();
  }

  schedule(
    markdown: string,
    editor?: HTMLTextAreaElement,
    options: PreviewRenderOptions = {}
  ): void {
    const { immediate = false, force = false, resetScroll = false } = options;

    const run = () => {
      void this.runRender(markdown, editor, force, resetScroll);
    };

    if (immediate) {
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.previewTimer = null;
      run();
      return;
    }

    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(run, FAST_DEBOUNCE_MS);
  }

  onThemeChange(): void {
    this.mermaidLazy.runAll(this.preview);
  }

  private scheduleMermaid(force = false): void {
    if (this.mermaidTimer) clearTimeout(this.mermaidTimer);
    this.mermaidTimer = setTimeout(() => {
      this.mermaidTimer = null;
      this.mermaidLazy.observe(this.preview, force);
    }, force ? 0 : MERMAID_DEBOUNCE_MS);
  }

  private syncBlockDomStructure(blocks: MarkdownBlock[], reset: boolean): void {
    if (reset) {
      this.preview.innerHTML = blocks
        .map(
          (block) =>
            `<section class="md-block" data-md-block="${block.index}" data-md-hash="${block.hash}"></section>`
        )
        .join("");
      return;
    }

    const existing = this.preview.querySelectorAll<HTMLElement>("[data-md-block]");
    if (existing.length === 0) {
      this.syncBlockDomStructure(blocks, true);
      return;
    }

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let element = this.preview.querySelector<HTMLElement>(
        `[data-md-block="${block.index}"]`
      );

      if (!element) {
        element = document.createElement("section");
        element.className = "md-block";
        element.dataset.mdBlock = String(block.index);
        element.dataset.mdHash = block.hash;
        this.preview.appendChild(element);
      } else {
        element.dataset.mdHash = block.hash;
      }

      if (existing[i] !== element) {
        const ref = this.preview.children[i] ?? null;
        this.preview.insertBefore(element, ref);
      }
    }

    while (this.preview.children.length > blocks.length) {
      this.preview.lastElementChild?.remove();
    }
  }

  private computeHeadingStartIndex(blocks: MarkdownBlock[], upToIndex: number): number {
    let count = 0;
    for (let i = 0; i < upToIndex; i++) {
      const raw = this.blockHashCache.get(blocks[i].hash);
      if (raw) count += countHeadingsInHtml(raw);
    }
    return count;
  }

  private applyBlockToDom(
    block: MarkdownBlock,
    headingStart: number,
    mermaidThemeKey: string
  ): number {
    const raw = this.blockHashCache.get(block.hash);
    if (!raw) return headingStart;

    const baseDir = this.getResourceBaseDir();
    const finalized = finalizeBlockHtml(raw, baseDir);
    const withIds = addHeadingIds(finalized, headingStart);

    const element = this.preview.querySelector<HTMLElement>(
      `[data-md-block="${block.index}"]`
    );
    if (!element) return withIds.nextIndex;

    element.dataset.mdHash = block.hash;
    if (element.innerHTML.length === 0) {
      element.innerHTML = withIds.html;
    } else {
      morphBlockElement(element, withIds.html, mermaidThemeKey);
    }

    return withIds.nextIndex;
  }

  private finishRender(): void {
    adjustOrderedListMarkers(this.preview);
    this.onAfterRender?.();
  }

  private refreshBlocksFromIndex(
    blocks: MarkdownBlock[],
    startIndex: number,
    mermaidThemeKey: string
  ): void {
    let headingIndex = this.computeHeadingStartIndex(blocks, startIndex);
    for (let i = startIndex; i < blocks.length; i++) {
      headingIndex = this.applyBlockToDom(blocks[i], headingIndex, mermaidThemeKey);
    }
  }

  private async runRender(
    markdown: string,
    editor: HTMLTextAreaElement | undefined,
    force: boolean,
    resetScroll: boolean
  ): Promise<void> {
    const generation = ++this.renderGeneration;

    if (force) {
      this.blockHashCache.clear();
      this.lastBlockHashes = [];
      this.lastBlocks = [];
    }

    const blocks = splitMarkdownIntoBlocks(markdown);

    if (blocks.length === 0) {
      this.preview.innerHTML = "";
      this.lastBlocks = [];
      this.lastBlockHashes = [];
      this.finishRender();
      return;
    }

    const dirtyIndices = force
      ? blocks.map((block) => block.index)
      : findDirtyBlockIndices(blocks, this.lastBlockHashes);

    const structureChanged =
      force ||
      blocks.length !== this.lastBlocks.length ||
      this.preview.querySelector("[data-md-block]") === null;

    this.syncBlockDomStructure(blocks, force);
    this.lastBlocks = blocks;
    this.lastBlockHashes = blocks.map((block) => block.hash);

    const workerDirty: number[] = [];
    const mermaidThemeKey = this.getIsDark() ? "dark" : "light";

    for (const index of dirtyIndices) {
      const block = blocks[index];
      const cached = this.blockHashCache.get(block.hash);
      if (cached && !force) {
        continue;
      }
      workerDirty.push(index);
    }

    const refreshStart =
      dirtyIndices.length > 0 ? Math.min(...dirtyIndices) : 0;

    if (workerDirty.length === 0) {
      if (dirtyIndices.length > 0 || structureChanged) {
        this.refreshBlocksFromIndex(
          blocks,
          refreshStart,
          mermaidThemeKey
        );
      }
      this.scheduleMermaid(force || structureChanged);
      this.finishRender();
      if (resetScroll && editor) {
        editor.scrollTop = 0;
        this.preview.scrollTop = 0;
      }
      return;
    }

    const requestId = ++this.workerRequestId;
    this.pendingWorkerRequest = requestId;

    this.worker.postMessage({
      requestId,
      blocks: blocks.map((block) => ({
        index: block.index,
        content: block.content,
        hash: block.hash,
      })),
      dirtyIndices: workerDirty,
    });

    if (resetScroll && editor) {
      editor.scrollTop = 0;
      this.preview.scrollTop = 0;
    }

    if (generation !== this.renderGeneration) return;
  }

  private handleWorkerResponse(data: {
    requestId: number;
    results: Array<{ index: number; hash: string; html: string }>;
  }): void {
    if (data.requestId !== this.pendingWorkerRequest) return;

    for (const result of data.results) {
      this.blockHashCache.set(result.hash, result.html);
    }

    const mermaidThemeKey = this.getIsDark() ? "dark" : "light";
    const refreshStart =
      data.results.length > 0
        ? Math.min(...data.results.map((r) => r.index))
        : 0;

    this.refreshBlocksFromIndex(this.lastBlocks, refreshStart, mermaidThemeKey);
    this.scheduleMermaid(false);
    this.finishRender();
  }
}

export function getResourceBaseDirFromFilePath(
  filePath: string | null
): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/[/\\][^/\\]+$/, "");
  return normalized || null;
}

export function resolvePreviewResourceUrl(
  href: string,
  filePath: string | null
): string {
  const baseDir = getResourceBaseDirFromFilePath(filePath);
  if (!href || REMOTE_URL_RE.test(href)) return href;
  const absolute = resolveResourcePath(href, baseDir);
  if (!isLocalAbsolutePath(absolute)) return href;
  try {
    return convertFileSrc(absolute);
  } catch {
    return href;
  }
}

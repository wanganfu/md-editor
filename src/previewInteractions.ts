import { isTauri } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { t } from "./i18n";

export interface PreviewInteractionOptions {
  preview: HTMLElement;
  resolveResourceUrl: (href: string) => string;
  resolveLocalFilePath: (href: string) => string | null;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.2;

let lightboxEl: HTMLElement | null = null;
let lightboxImage: HTMLImageElement | null = null;
let lightboxVideo: HTMLVideoElement | null = null;
let lightboxZoomLabel: HTMLElement | null = null;
let lightboxStage: HTMLElement | null = null;

let imageZoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragPanStartX = 0;
let dragPanStartY = 0;

function handleDocumentPointerMove(event: PointerEvent): void {
  if (!dragging) return;
  event.preventDefault();
  panX = dragPanStartX + (event.clientX - dragStartX);
  panY = dragPanStartY + (event.clientY - dragStartY);
  applyImageTransform();
}

function stopImageDrag(event: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  lightboxStage?.classList.remove("is-dragging");
  document.removeEventListener("pointermove", handleDocumentPointerMove);
  document.removeEventListener("pointerup", stopImageDrag);
  document.removeEventListener("pointercancel", stopImageDrag);
  if (lightboxStage && event.pointerId !== undefined) {
    try {
      lightboxStage.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  }
}

function updateStagePanState(): void {
  if (!lightboxStage || !lightboxImage) return;
  const canPan =
    !lightboxImage.classList.contains("hidden") &&
    (imageZoom > 1 || panX !== 0 || panY !== 0);
  lightboxStage.classList.toggle("is-pannable", canPan);
}

function ensureLightbox(): void {
  if (lightboxEl) return;

  lightboxEl = document.createElement("div");
  lightboxEl.id = "media-lightbox";
  lightboxEl.className = "media-lightbox hidden";
  lightboxEl.setAttribute("aria-hidden", "true");
  lightboxEl.innerHTML = `
    <div class="media-lightbox-backdrop" data-role="backdrop"></div>
    <div class="media-lightbox-panel" role="dialog" aria-modal="true">
      <div class="media-lightbox-stage" data-role="stage">
        <img class="media-lightbox-image hidden" data-role="image" alt="" draggable="false" />
        <video class="media-lightbox-video hidden" data-role="video" controls playsinline></video>
      </div>
      <div class="media-lightbox-toolbar">
        <button type="button" class="media-lightbox-btn" data-action="zoom-out" title="">
          <i class="fa-solid fa-minus" aria-hidden="true"></i>
        </button>
        <span class="media-lightbox-zoom-label" data-role="zoom-label">100%</span>
        <button type="button" class="media-lightbox-btn" data-action="zoom-in" title="">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
        </button>
        <button type="button" class="media-lightbox-btn" data-action="reset" title="">
          <i class="fa-solid fa-compress" aria-hidden="true"></i>
        </button>
        <button type="button" class="media-lightbox-btn media-lightbox-close" data-action="close" title="">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(lightboxEl);
  lightboxImage = lightboxEl.querySelector("[data-role=image]");
  lightboxVideo = lightboxEl.querySelector("[data-role=video]");
  lightboxZoomLabel = lightboxEl.querySelector("[data-role=zoom-label]");
  lightboxStage = lightboxEl.querySelector("[data-role=stage]");

  updateLightboxLabels();

  lightboxEl.querySelector("[data-role=backdrop]")?.addEventListener("click", () => {
    closeLightbox();
  });

  lightboxEl.querySelector(".media-lightbox-toolbar")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const button = (event.target as Element).closest<HTMLElement>("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    if (action === "close") closeLightbox();
    if (action === "zoom-in") setImageZoom(imageZoom + ZOOM_STEP);
    if (action === "zoom-out") setImageZoom(imageZoom - ZOOM_STEP);
    if (action === "reset") resetImageTransform();
  });

  lightboxEl.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  lightboxStage?.addEventListener("wheel", handleLightboxWheel, { passive: false });
  lightboxStage?.addEventListener("pointerdown", handleLightboxPointerDown);
  lightboxStage?.addEventListener("dragstart", (event) => {
    event.preventDefault();
  });
  lightboxImage?.addEventListener("dragstart", (event) => {
    event.preventDefault();
  });
  lightboxStage?.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (lightboxImage && !lightboxImage.classList.contains("hidden")) {
      setImageZoom(imageZoom > 1 ? 1 : 2);
    }
  });

  document.addEventListener("keydown", handleLightboxKeydown);
}

function updateLightboxLabels(): void {
  if (!lightboxEl) return;
  lightboxEl.querySelector("[data-action=zoom-in]")?.setAttribute(
    "title",
    t("lightbox.zoomIn")
  );
  lightboxEl.querySelector("[data-action=zoom-out]")?.setAttribute(
    "title",
    t("lightbox.zoomOut")
  );
  lightboxEl.querySelector("[data-action=reset]")?.setAttribute(
    "title",
    t("lightbox.reset")
  );
  lightboxEl.querySelector("[data-action=close]")?.setAttribute(
    "title",
    t("lightbox.close")
  );
}

export function refreshPreviewInteractionLabels(): void {
  updateLightboxLabels();
}

function updateZoomLabel(): void {
  if (!lightboxZoomLabel) return;
  lightboxZoomLabel.textContent = `${Math.round(imageZoom * 100)}%`;
}

function applyImageTransform(): void {
  if (!lightboxImage) return;
  lightboxImage.style.transform = `translate(${panX}px, ${panY}px) scale(${imageZoom})`;
  updateZoomLabel();
  updateStagePanState();
}

function resetImageTransform(): void {
  imageZoom = 1;
  panX = 0;
  panY = 0;
  applyImageTransform();
}

function setImageZoom(next: number): void {
  imageZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  if (imageZoom <= 1) {
    panX = 0;
    panY = 0;
  }
  applyImageTransform();
}

function handleLightboxWheel(event: WheelEvent): void {
  if (!lightboxImage || lightboxImage.classList.contains("hidden")) return;
  event.preventDefault();
  const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  setImageZoom(imageZoom + delta);
}

function handleLightboxPointerDown(event: PointerEvent): void {
  if (!lightboxImage || lightboxImage.classList.contains("hidden")) return;
  if (event.button !== 0) return;
  if (imageZoom <= 1) return;

  event.preventDefault();
  event.stopPropagation();

  dragging = true;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragPanStartX = panX;
  dragPanStartY = panY;

  lightboxStage?.classList.add("is-dragging");
  document.addEventListener("pointermove", handleDocumentPointerMove);
  document.addEventListener("pointerup", stopImageDrag);
  document.addEventListener("pointercancel", stopImageDrag);

  try {
    lightboxStage?.setPointerCapture(event.pointerId);
  } catch {
    /* WebView may reject capture on some targets */
  }
}

function handleLightboxKeydown(event: KeyboardEvent): void {
  if (!lightboxEl || lightboxEl.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeLightbox();
  }
}

function setLightboxOpen(open: boolean): void {
  document.body.classList.toggle("lightbox-open", open);
}

function openImageLightbox(image: HTMLImageElement): void {
  ensureLightbox();
  if (!lightboxEl || !lightboxImage || !lightboxVideo) return;

  lightboxVideo.pause();
  lightboxVideo.removeAttribute("src");
  lightboxVideo.classList.add("hidden");

  lightboxImage.src = image.currentSrc || image.src;
  lightboxImage.alt = image.alt || t("lightbox.image");
  lightboxImage.draggable = false;
  lightboxImage.classList.remove("hidden");
  resetImageTransform();
  lightboxImage.addEventListener(
    "load",
    () => updateStagePanState(),
    { once: true }
  );

  lightboxEl.classList.remove("hidden");
  lightboxEl.setAttribute("aria-hidden", "false");
  setLightboxOpen(true);
}

function openVideoLightbox(video: HTMLVideoElement): void {
  ensureLightbox();
  if (!lightboxEl || !lightboxImage || !lightboxVideo) return;

  lightboxImage.removeAttribute("src");
  lightboxImage.classList.add("hidden");
  resetImageTransform();

  const source = video.currentSrc || video.src;
  if (source) {
    lightboxVideo.src = source;
    lightboxVideo.classList.remove("hidden");
    void lightboxVideo.play().catch(() => undefined);
  }

  lightboxEl.classList.remove("hidden");
  lightboxEl.setAttribute("aria-hidden", "false");
  setLightboxOpen(true);
}

function closeLightbox(): void {
  if (!lightboxEl || !lightboxImage || !lightboxVideo) return;
  lightboxVideo.pause();
  lightboxVideo.removeAttribute("src");
  lightboxVideo.classList.add("hidden");
  lightboxImage.removeAttribute("src");
  lightboxImage.classList.add("hidden");
  lightboxEl.classList.add("hidden");
  lightboxEl.setAttribute("aria-hidden", "true");
  setLightboxOpen(false);
  dragging = false;
  lightboxStage?.classList.remove("is-dragging", "is-pannable");
  document.removeEventListener("pointermove", handleDocumentPointerMove);
  document.removeEventListener("pointerup", stopImageDrag);
  document.removeEventListener("pointercancel", stopImageDrag);
}

async function openExternalHref(
  href: string,
  options: PreviewInteractionOptions
): Promise<void> {
  const trimmed = href.trim();
  if (!trimmed || /^javascript:/i.test(trimmed)) return;

  if (trimmed.startsWith("#")) return;

  if (/^(https?:|mailto:|\/\/)/i.test(trimmed)) {
    const url = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    await openExternalUrl(url);
    return;
  }

  const localPath = options.resolveLocalFilePath(trimmed);
  if (localPath && isTauri()) {
    await openPath(localPath);
    return;
  }

  const resolved = options.resolveResourceUrl(trimmed);
  if (/^https?:\/\//i.test(resolved) || /^mailto:/i.test(resolved)) {
    await openExternalUrl(resolved);
    return;
  }

  if (isTauri()) {
    if (localPath) {
      await openPath(localPath);
      return;
    }
    await openUrl(resolved);
    return;
  }

  window.open(resolved, "_blank", "noopener,noreferrer");
}

async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function scrollToPreviewAnchor(preview: HTMLElement, hash: string): void {
  const id = decodeURIComponent(hash.slice(1));
  const target =
    preview.querySelector(`#${CSS.escape(id)}`) ??
    preview.querySelector(`[name="${CSS.escape(id)}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handlePreviewNavigationClick(
  event: MouseEvent,
  options: PreviewInteractionOptions
): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 && event.button !== 1) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  const image = target.closest("img");
  if (image instanceof HTMLImageElement && options.preview.contains(image)) {
    event.preventDefault();
    event.stopPropagation();
    openImageLightbox(image);
    return;
  }

  const video = target.closest("video");
  if (video instanceof HTMLVideoElement && options.preview.contains(video)) {
    event.preventDefault();
    event.stopPropagation();
    openVideoLightbox(video);
    return;
  }

  const anchor = target.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (!options.preview.contains(anchor)) return;

  const href = anchor.getAttribute("href");
  if (!href) return;

  event.preventDefault();
  event.stopPropagation();

  if (href.startsWith("#")) {
    scrollToPreviewAnchor(options.preview, href);
    return;
  }

  void openExternalHref(href, options).catch((error) => {
    console.error("打开链接失败:", error);
  });
}

export function initPreviewInteractions(options: PreviewInteractionOptions): void {
  ensureLightbox();

  const handler = (event: MouseEvent) =>
    handlePreviewNavigationClick(event, options);

  options.preview.addEventListener("click", handler, true);
  options.preview.addEventListener("auxclick", handler, true);
}

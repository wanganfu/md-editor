import { marked } from "marked";
import { markedMathExtension } from "./markedMath";
import { hashContent } from "./previewMorph";

const REMOTE_URL_RE =
  /^(https?:|\/\/|data:|mailto:|javascript:|#|asset:|blob:|https:\/\/asset\.)/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

/** Worker-safe: resolves to absolute path string, not convertFileSrc */
export function resolveResourcePath(
  href: string,
  baseDir: string | null
): string {
  if (!href || isRemoteResourceUrl(href) || !baseDir) return href;

  try {
    const decoded = decodeURIComponent(href.trim());
    const isAbsolute =
      /^[a-zA-Z]:[/\\]/.test(decoded) ||
      (decoded.startsWith("/") && !decoded.startsWith("//"));

    return isAbsolute
      ? decoded
      : joinPaths(baseDir, decoded);
  } catch {
    return href;
  }
}

export function rewriteLocalResourceUrls(
  html: string,
  baseDir: string | null
): string {
  if (!baseDir) return html;

  return html
    .replace(
      /(<a\b[^>]*?\shref=)(["'])(?!#)([^"']+)\2/gi,
      (_match, prefix, quote, href) => {
        if (isRemoteResourceUrl(href)) return _match;
        return `${prefix}${quote}${resolveResourcePath(href, baseDir)}${quote}`;
      }
    )
    .replace(
      /(<img\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi,
      (_match, prefix, quote, src) => {
        if (isRemoteResourceUrl(src)) return _match;
        return `${prefix}${quote}${resolveResourcePath(src, baseDir)}${quote}`;
      }
    )
    .replace(
      /(<(?:video|audio|source)\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi,
      (_match, prefix, quote, src) => {
        if (isRemoteResourceUrl(src)) return _match;
        return `${prefix}${quote}${resolveResourcePath(src, baseDir)}${quote}`;
      }
    );
}

export function addHeadingIds(
  html: string,
  startIndex = 0
): { html: string; nextIndex: number } {
  let index = startIndex;
  const result = html.replace(
    /<h([1-6])(\s[^>]*)?>/gi,
    (match, _level, attrs = "") => {
      if (/\bid\s*=/.test(attrs)) return match;
      const id = `heading-${index++}`;
      return `<h${_level} id="${id}"${attrs}>`;
    }
  );
  return { html: result, nextIndex: index };
}

let pipelineInitialized = false;

export function resetMermaidBlockIndex(): void {
  // Mermaid nodes use content hash ids; no global index required.
}

export function initMarkdownPipeline(): void {
  if (pipelineInitialized) return;
  pipelineInitialized = true;

  marked.setOptions({ breaks: true, gfm: true });
  marked.use(markedMathExtension());
  marked.use({
    renderer: {
      code({ text, lang }) {
        if (lang === "mermaid") {
          const source = text.trim();
          const contentKey = hashContent(source);
          return `<div class="mermaid" id="mermaid-${contentKey}" data-mermaid-key="${contentKey}">${escapeHtml(source)}</div>`;
        }

        const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
        return `<pre><code${langClass}>${escapeHtml(text)}\n</code></pre>\n`;
      },
    },
  });
}

export function parseMarkdownBlock(markdown: string): string {
  initMarkdownPipeline();
  resetMermaidBlockIndex();
  return marked.parse(markdown) as string;
}

export function parseMarkdownDocument(markdown: string): string {
  initMarkdownPipeline();
  resetMermaidBlockIndex();
  return marked.parse(markdown) as string;
}

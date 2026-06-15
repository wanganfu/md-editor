import { Idiomorph } from "idiomorph";

export function hashContent(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function morphPreviewHtml(
  preview: HTMLElement,
  html: string,
  mermaidThemeKey: string
): void {
  Idiomorph.morph(preview, html, {
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

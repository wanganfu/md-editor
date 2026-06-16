const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

export function buildAttachmentMarkdown(fileName: string, url: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) {
    return `![${fileName}](${url})`;
  }
  return `[${fileName}](${url})`;
}

export function isMarkdownFilePath(path: string): boolean {
  const name = path.split(/[/\\]/).pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  return ext === "md" || ext === "markdown";
}

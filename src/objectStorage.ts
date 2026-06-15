import { invoke } from "@tauri-apps/api/core";

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

export async function resolveAttachmentLink(
  filePath: string,
  script: string
): Promise<string> {
  const trimmed = script.trim();
  if (!trimmed) {
    throw new Error("链接脚本未配置");
  }

  const bytes = await invoke<number[]>("read_file_binary", { path: filePath });
  const fileName = filePath.split(/[/\\]/).pop() || "file";
  const fileBytes = new Uint8Array(bytes);

  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (
    ...args: string[]
  ) => (
    fileName: string,
    filePath: string,
    fileBytes: Uint8Array
  ) => Promise<unknown>;

  const runner = new AsyncFunction(
    "fileName",
    "filePath",
    "fileBytes",
    `${trimmed}\nif (typeof getLink !== "function") {\n  throw new Error("getLink() is not defined");\n}\nreturn await getLink(fileName, filePath, fileBytes);`
  );

  const result = await runner(fileName, filePath, fileBytes);
  if (typeof result !== "string" || !result.trim()) {
    throw new Error("getLink() 必须返回非空字符串链接");
  }
  return result.trim();
}

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

import { invoke } from "@tauri-apps/api/core";

export async function loadDocumentHistory(): Promise<string[]> {
  try {
    return await invoke<string[]>("get_document_history");
  } catch (e) {
    console.error("加载文档历史失败:", e);
    return [];
  }
}

export async function saveDocumentHistory(paths: string[]): Promise<void> {
  await invoke("save_document_history", { paths });
}

export function addToDocumentHistory(
  paths: string[],
  filePath: string
): string[] {
  const normalized = filePath.trim();
  if (!normalized) return paths;

  const rest = paths.filter((p) => p !== normalized);
  return [normalized, ...rest];
}

export function removeFromDocumentHistoryList(
  paths: string[],
  filePath: string
): string[] {
  return paths.filter((p) => p !== filePath);
}

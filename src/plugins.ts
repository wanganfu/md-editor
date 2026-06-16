import { invoke } from "@tauri-apps/api/core";

export interface PluginConfigField {
  key: string;
  label: string;
  sensitive: boolean;
  optional: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  pluginType: string;
  configSection: string;
  configFields: PluginConfigField[];
  hasUploadAction: boolean;
  pluginDir: string;
}

export async function listPlugins(): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("list_plugins");
}

export async function invokePluginUpload(
  pluginId: string,
  filePath: string,
  pluginConfig: Record<string, string>
): Promise<string> {
  const url = await invoke<string>("invoke_plugin_action", {
    pluginId,
    actionId: "upload",
    filePath,
    key: null,
    pluginConfig,
  });
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("插件未返回有效链接");
  }
  return url.trim();
}

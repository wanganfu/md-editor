import { invoke } from "@tauri-apps/api/core";
import type { Language } from "./i18n";

export type ViewMode = "edit" | "split" | "preview";
export type ThemeMode = "light" | "dark";
export type SidebarTab = "files" | "toc";

export interface AppSettings {
  defaultViewMode: ViewMode;
  defaultScrollSyncLocked: boolean;
  defaultSidebarVisible: boolean;
  defaultSidebarTab: SidebarTab;
  showSiblingDocuments: boolean;
  showHistoryDocuments: boolean;
  documentListSplitRatio: number;
  language: Language;
  theme: ThemeMode;
  pluginUploadEnabled: boolean;
  activeUploadPluginId: string | null;
  pluginConfigs: Record<string, Record<string, string>>;
}

export const SETTINGS_CACHE_KEY = "md-editor:settings-cache";

export const DEFAULT_SETTINGS: AppSettings = {
  defaultViewMode: "split",
  defaultScrollSyncLocked: false,
  defaultSidebarVisible: false,
  defaultSidebarTab: "files",
  showSiblingDocuments: true,
  showHistoryDocuments: false,
  documentListSplitRatio: 0.5,
  language: "zh",
  theme: "light",
  pluginUploadEnabled: false,
  activeUploadPluginId: null,
  pluginConfigs: {},
};

type LegacyAppSettings = Partial<AppSettings> & {
  documentListMode?: string;
  attachmentUploadEnabled?: boolean;
  attachmentLinkScript?: string;
};

function isViewMode(value: string): value is ViewMode {
  return value === "edit" || value === "split" || value === "preview";
}

function isLanguage(value: string): value is Language {
  return value === "zh" || value === "en";
}

function isTheme(value: string): value is ThemeMode {
  return value === "light" || value === "dark";
}

function isSidebarTab(value: string): value is SidebarTab {
  return value === "files" || value === "toc";
}

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.documentListSplitRatio;
  return Math.max(0.2, Math.min(0.8, value));
}

function resolveDocumentListFlags(raw: LegacyAppSettings): {
  showSiblingDocuments: boolean;
  showHistoryDocuments: boolean;
} {
  if (
    raw.showSiblingDocuments !== undefined ||
    raw.showHistoryDocuments !== undefined
  ) {
    return {
      showSiblingDocuments:
        raw.showSiblingDocuments ?? DEFAULT_SETTINGS.showSiblingDocuments,
      showHistoryDocuments:
        raw.showHistoryDocuments ?? DEFAULT_SETTINGS.showHistoryDocuments,
    };
  }

  if (raw.documentListMode === "history") {
    return { showSiblingDocuments: false, showHistoryDocuments: true };
  }

  return {
    showSiblingDocuments: true,
    showHistoryDocuments: false,
  };
}

function migrateLegacyAttachmentSettings(raw: LegacyAppSettings): {
  pluginUploadEnabled: boolean;
  activeUploadPluginId: string | null;
} {
  if (
    raw.pluginUploadEnabled !== undefined ||
    raw.activeUploadPluginId !== undefined
  ) {
    return {
      pluginUploadEnabled:
        raw.pluginUploadEnabled ?? DEFAULT_SETTINGS.pluginUploadEnabled,
      activeUploadPluginId:
        raw.activeUploadPluginId ?? DEFAULT_SETTINGS.activeUploadPluginId,
    };
  }

  if (raw.attachmentUploadEnabled) {
    return { pluginUploadEnabled: true, activeUploadPluginId: null };
  }

  return {
    pluginUploadEnabled: DEFAULT_SETTINGS.pluginUploadEnabled,
    activeUploadPluginId: DEFAULT_SETTINGS.activeUploadPluginId,
  };
}

function normalizePluginConfigs(
  raw: LegacyAppSettings
): Record<string, Record<string, string>> {
  if (raw.pluginConfigs && typeof raw.pluginConfigs === "object") {
    return raw.pluginConfigs;
  }
  return DEFAULT_SETTINGS.pluginConfigs;
}

function normalizeSettings(raw: LegacyAppSettings): AppSettings {
  const documentFlags = resolveDocumentListFlags(raw);
  const pluginFlags = migrateLegacyAttachmentSettings(raw);

  return {
    defaultViewMode: isViewMode(raw.defaultViewMode ?? "")
      ? raw.defaultViewMode!
      : DEFAULT_SETTINGS.defaultViewMode,
    defaultScrollSyncLocked:
      raw.defaultScrollSyncLocked ?? DEFAULT_SETTINGS.defaultScrollSyncLocked,
    defaultSidebarVisible:
      raw.defaultSidebarVisible ?? DEFAULT_SETTINGS.defaultSidebarVisible,
    defaultSidebarTab: isSidebarTab(raw.defaultSidebarTab ?? "")
      ? raw.defaultSidebarTab!
      : DEFAULT_SETTINGS.defaultSidebarTab,
    showSiblingDocuments: documentFlags.showSiblingDocuments,
    showHistoryDocuments: documentFlags.showHistoryDocuments,
    documentListSplitRatio: clampSplitRatio(
      raw.documentListSplitRatio ?? DEFAULT_SETTINGS.documentListSplitRatio
    ),
    language: isLanguage(raw.language ?? "")
      ? raw.language!
      : DEFAULT_SETTINGS.language,
    theme: isTheme(raw.theme ?? "") ? raw.theme! : DEFAULT_SETTINGS.theme,
    pluginUploadEnabled: pluginFlags.pluginUploadEnabled,
    activeUploadPluginId: pluginFlags.activeUploadPluginId,
    pluginConfigs: normalizePluginConfigs(raw),
  };
}

export function readCachedAppSettings(): AppSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    return normalizeSettings(JSON.parse(raw) as LegacyAppSettings);
  } catch {
    return null;
  }
}

export function cacheAppSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(
      SETTINGS_CACHE_KEY,
      JSON.stringify(normalizeSettings(settings))
    );
  } catch {
    /* localStorage may be unavailable */
  }
}

export async function loadAppSettings(): Promise<AppSettings> {
  try {
    const raw = await invoke<LegacyAppSettings>("get_app_settings");
    const settings = normalizeSettings(raw);
    cacheAppSettings(settings);
    return settings;
  } catch (e) {
    console.error("加载设置失败:", e);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  cacheAppSettings(normalized);
  await invoke("save_app_settings", { settings: normalized });
}

export function getPluginConfig(
  settings: AppSettings,
  pluginId: string
): Record<string, string> {
  return { ...(settings.pluginConfigs[pluginId] ?? {}) };
}

export function setPluginConfig(
  settings: AppSettings,
  pluginId: string,
  config: Record<string, string>
): AppSettings {
  return {
    ...settings,
    pluginConfigs: {
      ...settings.pluginConfigs,
      [pluginId]: { ...config },
    },
  };
}

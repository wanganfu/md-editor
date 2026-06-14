import {
  cacheAppSettings,
  readCachedAppSettings,
  type AppSettings,
} from "./settings";

export function applyBootstrapSettingsToDocument(
  settings: AppSettings | null
): void {
  if (!settings) return;

  const root = document.documentElement;
  root.classList.toggle("dark", settings.theme === "dark");
  root.dataset.viewMode = settings.defaultViewMode;
  root.dataset.sidebar = settings.defaultSidebarVisible ? "open" : "closed";
  root.lang = settings.language === "en" ? "en" : "zh-CN";
}

export function syncBootstrapSettingsToDocument(settings: AppSettings): void {
  applyBootstrapSettingsToDocument(settings);
  cacheAppSettings(settings);
}

export function markAppReady(): void {
  document.documentElement.classList.add("app-ready");
}

/** Runs as early as possible (module load) to align with cached startup state. */
applyBootstrapSettingsToDocument(readCachedAppSettings());

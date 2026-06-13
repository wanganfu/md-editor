use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
  pub default_view_mode: String,
  pub default_scroll_sync_locked: bool,
  pub default_sidebar_visible: bool,
  #[serde(default)]
  pub default_sidebar_tab: String,
  #[serde(default = "default_true")]
  pub show_sibling_documents: bool,
  #[serde(default)]
  pub show_history_documents: bool,
  #[serde(default = "default_split_ratio")]
  pub document_list_split_ratio: f64,
  #[serde(default)]
  pub document_list_mode: String,
  pub language: String,
  pub theme: String,
}

fn default_true() -> bool {
  true
}

fn default_split_ratio() -> f64 {
  0.5
}

impl Default for AppSettings {
  fn default() -> Self {
    Self {
      default_view_mode: "split".to_string(),
      default_scroll_sync_locked: false,
      default_sidebar_visible: false,
      default_sidebar_tab: "files".to_string(),
      show_sibling_documents: true,
      show_history_documents: false,
      document_list_split_ratio: 0.5,
      document_list_mode: String::new(),
      language: "zh".to_string(),
      theme: "light".to_string(),
    }
  }
}

fn settings_file_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(dir.join("settings.json"))
}

fn clamp_split_ratio(value: f64) -> f64 {
  if !value.is_finite() {
    return 0.5;
  }
  value.clamp(0.2, 0.8)
}

fn resolve_document_list_flags(raw: &AppSettings) -> (bool, bool) {
  if !raw.document_list_mode.is_empty() {
    match raw.document_list_mode.as_str() {
      "history" => return (false, true),
      "siblings" => return (true, false),
      _ => {}
    }
  }

  (raw.show_sibling_documents, raw.show_history_documents)
}

fn merge_with_defaults(raw: AppSettings) -> AppSettings {
  let defaults = AppSettings::default();
  let (show_sibling_documents, show_history_documents) = resolve_document_list_flags(&raw);

  AppSettings {
    default_view_mode: if raw.default_view_mode.is_empty() {
      defaults.default_view_mode
    } else {
      raw.default_view_mode
    },
    default_scroll_sync_locked: raw.default_scroll_sync_locked,
    default_sidebar_visible: raw.default_sidebar_visible,
    default_sidebar_tab: if raw.default_sidebar_tab.is_empty() {
      defaults.default_sidebar_tab
    } else {
      raw.default_sidebar_tab
    },
    show_sibling_documents,
    show_history_documents,
    document_list_split_ratio: clamp_split_ratio(raw.document_list_split_ratio),
    document_list_mode: String::new(),
    language: if raw.language.is_empty() {
      defaults.language
    } else {
      raw.language
    },
    theme: if raw.theme.is_empty() {
      defaults.theme
    } else {
      raw.theme
    },
  }
}

#[command]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
  let path = settings_file_path(&app)?;
  if !path.exists() {
    return Ok(AppSettings::default());
  }

  let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let parsed = serde_json::from_str::<AppSettings>(&content).unwrap_or_default();
  Ok(merge_with_defaults(parsed))
}

#[command]
pub fn save_app_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
  let path = settings_file_path(&app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let merged = merge_with_defaults(settings);
  let content = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
  fs::write(path, content).map_err(|e| e.to_string())?;
  Ok(())
}

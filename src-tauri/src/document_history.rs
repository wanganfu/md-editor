use std::fs;
use std::path::PathBuf;

use tauri::{command, AppHandle, Manager};

fn history_file_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  Ok(dir.join("document_history.json"))
}

#[command]
pub fn get_document_history(app: AppHandle) -> Result<Vec<String>, String> {
  let path = history_file_path(&app)?;
  if !path.exists() {
    return Ok(Vec::new());
  }

  let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
  serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[command]
pub fn save_document_history(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
  let path = history_file_path(&app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let content = serde_json::to_string_pretty(&paths).map_err(|e| e.to_string())?;
  fs::write(path, content).map_err(|e| e.to_string())?;
  Ok(())
}

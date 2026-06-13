mod file_assoc;
mod document_history;
mod settings;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{command, AppHandle, Manager, State};

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::Emitter;

struct LaunchState {
  files: Mutex<Vec<String>>,
}

#[command]
fn read_file(path: &str) -> Result<String, String> {
  fs::read_to_string(path).map_err(|e| e.to_string())
}

#[command]
fn write_file(path: &str, content: &str) -> Result<(), String> {
  fs::write(path, content).map_err(|e| e.to_string())
}

#[command]
fn file_exists(path: &str) -> bool {
  std::path::Path::new(path).exists()
}

#[command]
fn is_regular_file(path: &str) -> bool {
  file_assoc::is_openable_file(std::path::Path::new(path))
}

#[command]
fn list_md_files(dir: &str) -> Result<Vec<String>, String> {
  let mut files = Vec::new();
  let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
  for entry in entries {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    if path.is_file() && file_assoc::is_markdown_file(&path) {
      files.push(path.to_string_lossy().to_string());
    }
  }
  files.sort();
  Ok(files)
}

#[command]
fn take_launch_files(state: State<LaunchState>) -> Vec<String> {
  state.files.lock().unwrap().drain(..).collect()
}

#[command]
fn register_md_default_handler() -> Result<(), String> {
  file_assoc::register_md_file_association()
}

#[command]
fn is_md_default_handler() -> bool {
  file_assoc::is_md_default_handler()
}

fn allow_launch_file_scopes(app: &AppHandle, files: &[PathBuf]) {
  let asset_scope = app.asset_protocol_scope();
  for file in files {
    let _ = asset_scope.allow_file(file);
  }
}

fn normalize_opened_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
  paths
    .into_iter()
    .filter(|path| file_assoc::is_openable_file(path))
    .collect()
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
fn ingest_opened_files(app: &AppHandle, paths: Vec<PathBuf>) {
  let paths = normalize_opened_paths(paths);
  if paths.is_empty() {
    return;
  }

  allow_launch_file_scopes(app, &paths);

  let path_strings: Vec<String> = paths
    .iter()
    .map(|path| path.to_string_lossy().into_owned())
    .collect();

  if let Some(state) = app.try_state::<LaunchState>() {
    state
      .files
      .lock()
      .unwrap()
      .extend(path_strings.iter().cloned());
  }

  let _ = app.emit("open-files", path_strings);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let launch_files = normalize_opened_paths(file_assoc::collect_launch_files());
      allow_launch_file_scopes(app.handle(), &launch_files);

      let launch_paths = launch_files
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();

      app.manage(LaunchState {
        files: Mutex::new(launch_paths),
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      read_file,
      write_file,
      file_exists,
      is_regular_file,
      list_md_files,
      take_launch_files,
      register_md_default_handler,
      is_md_default_handler,
      settings::get_app_settings,
      settings::save_app_settings,
      document_history::get_document_history,
      document_history::save_document_history
    ])
    .build(tauri::generate_context!())
    .expect("error while running tauri application")
    .run(|app_handle, event| {
      #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
      if let tauri::RunEvent::Opened { urls } = event {
        let paths = urls
          .into_iter()
          .filter_map(|url| url.to_file_path().ok())
          .collect();
        ingest_opened_files(app_handle, paths);
      }

      let _ = (app_handle, event);
    });
}

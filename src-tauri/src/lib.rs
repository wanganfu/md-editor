mod file_assoc;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{command, Manager, State};

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

fn allow_launch_file_scopes(app: &tauri::App, files: &[PathBuf]) {
  let asset_scope = app.asset_protocol_scope();
  for file in files {
    let _ = asset_scope.allow_file(file);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let launch_files: Vec<PathBuf> = file_assoc::collect_launch_files()
        .into_iter()
        .filter(|path| path.exists() && file_assoc::is_markdown_file(path))
        .collect();
      allow_launch_file_scopes(app, &launch_files);

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
      list_md_files,
      take_launch_files,
      register_md_default_handler,
      is_md_default_handler
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

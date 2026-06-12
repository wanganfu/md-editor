use std::fs;
use tauri::command;

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
        if path.is_file() {
            if let Some(ext) = path.extension() {
                let ext = ext.to_string_lossy().to_lowercase();
                if ext == "md" || ext == "markdown" || ext == "txt" {
                    files.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_exists,
            list_md_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

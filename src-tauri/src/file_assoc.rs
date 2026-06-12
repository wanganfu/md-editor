use std::path::{Path, PathBuf};

#[cfg(windows)]
const PROG_ID: &str = "me.anfu.md-editor.md";
const MD_EXTENSIONS: &[&str] = &["md", "markdown"];

pub fn collect_launch_files() -> Vec<PathBuf> {
  std::env::args()
    .skip(1)
    .filter_map(|arg| parse_launch_arg(&arg))
    .collect()
}

pub fn parse_launch_arg(arg: &str) -> Option<PathBuf> {
  let arg = arg.trim().trim_matches('"');
  if arg.is_empty() || arg.starts_with('-') {
    return None;
  }

  if arg.starts_with("file:") {
    return url::Url::parse(arg)
      .ok()
      .and_then(|url| url.to_file_path().ok());
  }

  if is_windows_abs_path(arg) || arg.starts_with('/') {
    return Some(PathBuf::from(arg));
  }

  if let Ok(url) = url::Url::parse(arg) {
    if url.scheme() == "file" {
      return url.to_file_path().ok();
    }
  }

  Some(PathBuf::from(arg))
}

fn is_windows_abs_path(path: &str) -> bool {
  let bytes = path.as_bytes();
  bytes.len() >= 3
    && bytes[0].is_ascii_alphabetic()
    && bytes[1] == b':'
    && (bytes[2] == b'\\' || bytes[2] == b'/')
}

pub fn is_markdown_file(path: &Path) -> bool {
  path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| {
    let ext_lower = ext.to_ascii_lowercase();
    MD_EXTENSIONS.contains(&ext_lower.as_str())
  })
}

/// Launch / drag-open: accept any regular file; extension is ignored when reading as text.
pub fn is_openable_file(path: &Path) -> bool {
  path.is_file()
}

#[cfg(windows)]
pub fn register_md_file_association() -> Result<(), String> {
  use winreg::enums::*;
  use winreg::RegKey;

  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  let exe_str = exe.to_string_lossy();
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);

  let (prog_key, _) = hkcu
    .create_subkey(format!("Software\\Classes\\{PROG_ID}"))
    .map_err(|e| e.to_string())?;
  prog_key
    .set_value("", &"Markdown Document")
    .map_err(|e| e.to_string())?;

  let (icon_key, _) = hkcu
    .create_subkey(format!("Software\\Classes\\{PROG_ID}\\DefaultIcon"))
    .map_err(|e| e.to_string())?;
  icon_key
    .set_value("", &format!("{exe_str},0"))
    .map_err(|e| e.to_string())?;

  let (open_key, _) = hkcu
    .create_subkey(format!("Software\\Classes\\{PROG_ID}\\shell\\open\\command"))
    .map_err(|e| e.to_string())?;
  open_key
    .set_value("", &format!("\"{exe_str}\" \"%1\""))
    .map_err(|e| e.to_string())?;

  for ext in MD_EXTENSIONS {
    let (ext_key, _) = hkcu
      .create_subkey(format!("Software\\Classes\\.{ext}"))
      .map_err(|e| e.to_string())?;
    ext_key.set_value("", &PROG_ID).map_err(|e| e.to_string())?;

    let (owp_key, _) = hkcu
      .create_subkey(format!("Software\\Classes\\.{ext}\\OpenWithProgids"))
      .map_err(|e| e.to_string())?;
    owp_key
      .set_value(PROG_ID, &"")
      .map_err(|e| e.to_string())?;
  }

  notify_shell_association_changed();
  Ok(())
}

#[cfg(windows)]
pub fn is_md_default_handler() -> bool {
  use winreg::enums::*;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  hkcu.open_subkey("Software\\Classes\\.md")
    .and_then(|key| key.get_value::<String, _>(""))
    .map(|value| value == PROG_ID)
    .unwrap_or(false)
}

#[cfg(windows)]
fn notify_shell_association_changed() {
  use std::ptr::null_mut;

  #[link(name = "shell32")]
  extern "system" {
    fn SHChangeNotify(
      event_id: i32,
      flags: u32,
      item1: *const std::ffi::c_void,
      item2: *const std::ffi::c_void,
    );
  }

  const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
  const SHCNF_IDLIST: u32 = 0x0000;

  unsafe {
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, null_mut(), null_mut());
  }
}

#[cfg(not(windows))]
pub fn register_md_file_association() -> Result<(), String> {
  Err("仅支持在 Windows 上注册默认打开方式".into())
}

#[cfg(not(windows))]
pub fn is_md_default_handler() -> bool {
  false
}

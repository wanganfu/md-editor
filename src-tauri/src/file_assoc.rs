use std::path::{Path, PathBuf};

const PROG_ID: &str = "me.anfu.md-editor.md";
const MD_EXTENSIONS: &[&str] = &["md", "markdown"];

pub fn collect_launch_files() -> Vec<PathBuf> {
  let mut files = Vec::new();

  for maybe_file in std::env::args().skip(1) {
    if maybe_file.starts_with('-') {
      continue;
    }

    if let Ok(url) = url::Url::parse(&maybe_file) {
      if let Ok(path) = url.to_file_path() {
        files.push(path);
      }
    } else {
      files.push(PathBuf::from(maybe_file));
    }
  }

  files
}

pub fn is_markdown_file(path: &Path) -> bool {
  path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| {
    let ext_lower = ext.to_ascii_lowercase();
    MD_EXTENSIONS.contains(&ext_lower.as_str())
  })
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

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{command, AppHandle, Manager};

const PLUGIN_MANIFEST: &str = "plugin.json";
const UPLOAD_ACTION: &str = "upload";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigField {
  pub key: String,
  pub label: String,
  pub sensitive: bool,
  pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
  pub id: String,
  pub name: String,
  pub version: String,
  pub description: String,
  pub author: String,
  pub plugin_type: String,
  pub config_section: String,
  pub config_fields: Vec<PluginConfigField>,
  pub has_upload_action: bool,
  pub plugin_dir: String,
}

#[derive(Debug, Deserialize)]
struct PluginManifestRoot {
  plugin: PluginMeta,
  #[serde(flatten)]
  extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct PluginMeta {
  id: String,
  name: String,
  version: String,
  #[serde(default)]
  description: String,
  #[serde(default)]
  author: String,
  #[serde(rename = "type")]
  plugin_type: String,
  binary: PluginBinary,
  invoke: PluginInvoke,
  action: HashMap<String, PluginAction>,
}

#[derive(Debug, Deserialize)]
struct PluginBinary {
  path: String,
  #[serde(default)]
  platforms: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PluginInvoke {
  config_mapping: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PluginAction {
  #[serde(default, rename = "id")]
  _id: String,
  #[serde(default)]
  params: HashMap<String, PluginParam>,
}

#[derive(Debug, Deserialize)]
struct PluginParam {
  #[serde(rename = "type")]
  param_type: String,
  #[serde(default)]
  required: bool,
  cli_flag: String,
  #[serde(default)]
  cli_value_prefix: String,
}

fn current_platform_key() -> &'static str {
  if cfg!(target_os = "windows") {
    "windows"
  } else if cfg!(target_os = "macos") {
    "darwin"
  } else {
    "linux"
  }
}

fn plugins_roots(app: &AppHandle) -> Vec<PathBuf> {
  let mut roots = Vec::new();

  if let Ok(resource_dir) = app.path().resource_dir() {
    roots.push(resource_dir.join("plugins"));
  }

  if let Ok(exe_dir) = app.path().executable_dir() {
    roots.push(exe_dir.join("plugins"));
  }

  let dev_plugins = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .map(|p| p.join("plugins"));
  if let Some(dev) = dev_plugins {
    roots.push(dev);
  }

  roots
}

fn resolve_plugins_dir(app: &AppHandle) -> Option<PathBuf> {
  for root in plugins_roots(app) {
    if root.is_dir() {
      return Some(root);
    }
  }
  None
}

fn is_safe_plugin_path(base: &Path, candidate: &Path) -> bool {
  let base = base
    .canonicalize()
    .unwrap_or_else(|_| base.to_path_buf());
  let resolved = candidate
    .canonicalize()
    .unwrap_or_else(|_| candidate.to_path_buf());
  resolved.starts_with(base)
}

fn find_config_section(
  extra: &HashMap<String, Value>,
  mapping_keys: &[String],
) -> Option<String> {
  for (key, value) in extra {
    if key == "examples" {
      continue;
    }
    if let Some(obj) = value.as_object() {
      if mapping_keys.iter().all(|k| obj.contains_key(k)) {
        return Some(key.clone());
      }
    }
  }
  None
}

fn label_for_config_key(key: &str) -> String {
  key
    .split('_')
    .map(|part| {
      let mut chars = part.chars();
      match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

fn is_sensitive_config_key(key: &str) -> bool {
  let lower = key.to_ascii_lowercase();
  lower.contains("secret")
    || lower.contains("password")
    || lower.contains("token")
    || lower.ends_with("_key") && lower != "access_key_id"
    || lower == "sk"
}

fn ordered_config_mapping_keys(plugin_dir: &Path) -> Vec<String> {
  let manifest_path = plugin_dir.join(PLUGIN_MANIFEST);
  if let Ok(content) = fs::read_to_string(&manifest_path) {
    if let Ok(root) = serde_json::from_str::<Value>(&content) {
      if let Some(obj) = root
        .pointer("/plugin/invoke/config_mapping")
        .and_then(|value| value.as_object())
      {
        return obj.keys().cloned().collect();
      }

      if let Some(section) = root.as_object() {
        for (key, value) in section {
          if key == "plugin" || key == "examples" {
            continue;
          }
          if let Some(obj) = value.as_object() {
            return obj.keys().cloned().collect();
          }
        }
      }
    }
  }

  Vec::new()
}

fn read_manifest(plugin_dir: &Path) -> Result<(PluginMeta, HashMap<String, Value>), String> {
  let manifest_path = plugin_dir.join(PLUGIN_MANIFEST);
  let content = fs::read_to_string(&manifest_path)
    .map_err(|e| format!("读取插件清单失败 ({}): {e}", manifest_path.display()))?;
  let root: PluginManifestRoot = serde_json::from_str(&content)
    .map_err(|e| format!("解析插件清单失败 ({}): {e}", manifest_path.display()))?;
  Ok((root.plugin, root.extra))
}

fn plugin_info_from_dir(plugin_dir: &Path) -> Result<PluginInfo, String> {
  let (meta, extra) = read_manifest(plugin_dir)?;
  let mut mapping_keys = ordered_config_mapping_keys(plugin_dir);
  if mapping_keys.is_empty() {
    mapping_keys = meta.invoke.config_mapping.keys().cloned().collect();
  }
  let config_section = find_config_section(&extra, &mapping_keys)
    .unwrap_or_else(|| "config".to_string());

  let section_obj = extra
    .get(&config_section)
    .and_then(|v| v.as_object())
    .cloned()
    .unwrap_or_default();

  let config_fields: Vec<PluginConfigField> = mapping_keys
    .iter()
    .map(|key| {
      let optional = section_obj
        .get(key)
        .map(|v| v.as_str().unwrap_or("").trim().is_empty())
        .unwrap_or(false);
      PluginConfigField {
        key: key.clone(),
        label: label_for_config_key(key),
        sensitive: is_sensitive_config_key(key),
        optional,
      }
    })
    .collect();

  let has_upload_action = meta.action.contains_key(UPLOAD_ACTION);

  Ok(PluginInfo {
    id: meta.id,
    name: meta.name,
    version: meta.version,
    description: meta.description,
    author: meta.author,
    plugin_type: meta.plugin_type,
    config_section,
    config_fields,
    has_upload_action,
    plugin_dir: plugin_dir.to_string_lossy().into_owned(),
  })
}

fn find_plugin_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
  let plugins_dir = resolve_plugins_dir(app).ok_or_else(|| "未找到 plugins 目录".to_string())?;
  let entries = fs::read_dir(&plugins_dir).map_err(|e| e.to_string())?;

  for entry in entries {
    let entry = entry.map_err(|e| e.to_string())?;
    let plugin_dir = entry.path();
    if !plugin_dir.is_dir() {
      continue;
    }
    let (meta, _) = read_manifest(&plugin_dir)?;
    if meta.id == plugin_id {
      return Ok(plugin_dir);
    }
  }

  Err(format!("未找到插件: {plugin_id}"))
}

fn resolve_binary_path(plugin_dir: &Path, binary: &PluginBinary) -> Result<PathBuf, String> {
  let platform = current_platform_key();
  let file_name = binary
    .platforms
    .get(platform)
    .cloned()
    .unwrap_or_else(|| binary.path.clone());

  let candidate = plugin_dir.join(file_name);
  if !candidate.is_file() {
    return Err(format!(
      "插件二进制不存在: {}",
      candidate.to_string_lossy()
    ));
  }

  if !is_safe_plugin_path(plugin_dir, &candidate) {
    return Err("插件二进制路径不安全".to_string());
  }

  Ok(candidate)
}

fn canonicalize_file_arg(path: &str) -> Result<PathBuf, String> {
  let path = PathBuf::from(path);
  if path
    .components()
    .any(|c| matches!(c, Component::ParentDir))
  {
    return Err("文件路径非法".to_string());
  }
  if !path.is_file() {
    return Err(format!("文件不存在: {}", path.to_string_lossy()));
  }
  path.canonicalize().map_err(|e| e.to_string())
}

fn configure_hidden_cli(cmd: &mut Command) {
  cmd.stdin(Stdio::null());

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }
}

fn extract_url_from_text(text: &str) -> Option<String> {
  for line in text.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }

    if let Ok(json) = serde_json::from_str::<Value>(trimmed) {
      if let Some(url) = json.get("url").and_then(|v| v.as_str()) {
        let url = url.trim();
        if url.starts_with("http://") || url.starts_with("https://") {
          return Some(url.to_string());
        }
      }
    }

    for token in trimmed.split_whitespace() {
      let token = token.trim_matches('"').trim_matches('\'');
      if token.starts_with("http://") || token.starts_with("https://") {
        return Some(token.to_string());
      }
    }
  }

  None
}

fn parse_upload_url(stdout: &str) -> Result<String, String> {
  let trimmed = stdout.trim();
  if trimmed.is_empty() {
    return Err("插件未返回上传链接".to_string());
  }

  if let Some(url) = extract_url_from_text(trimmed) {
    return Ok(url);
  }

  Err(format!(
    "无法解析插件输出为链接: {}",
    trimmed.lines().last().unwrap_or(trimmed)
  ))
}

#[command]
pub fn list_plugins(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
  let plugins_dir = match resolve_plugins_dir(&app) {
    Some(dir) => dir,
    None => return Ok(Vec::new()),
  };

  let entries = fs::read_dir(&plugins_dir).map_err(|e| e.to_string())?;
  let mut plugins = Vec::new();

  for entry in entries {
    let entry = entry.map_err(|e| e.to_string())?;
    let plugin_dir = entry.path();
    if !plugin_dir.is_dir() {
      continue;
    }
    if !plugin_dir.join(PLUGIN_MANIFEST).is_file() {
      continue;
    }
    match plugin_info_from_dir(&plugin_dir) {
      Ok(info) => plugins.push(info),
      Err(e) => {
        eprintln!("跳过插件 {}: {}", plugin_dir.to_string_lossy(), e);
      }
    }
  }

  plugins.sort_by(|a, b| a.name.cmp(&b.name));
  Ok(plugins)
}

#[command]
pub fn invoke_plugin_action(
  app: AppHandle,
  plugin_id: String,
  action_id: String,
  file_path: String,
  key: Option<String>,
  plugin_config: HashMap<String, String>,
) -> Result<String, String> {
  if action_id != UPLOAD_ACTION {
    return Err(format!("暂不支持插件动作: {action_id}"));
  }

  let plugin_dir = find_plugin_dir(&app, &plugin_id)?;
  let (meta, _) = read_manifest(&plugin_dir)?;

  if meta.plugin_type != "cli" {
    return Err(format!("暂不支持插件类型: {}", meta.plugin_type));
  }

  let action = meta
    .action
    .get(UPLOAD_ACTION)
    .ok_or_else(|| format!("插件 {plugin_id} 未定义 upload 动作"))?;

  let binary_path = resolve_binary_path(&plugin_dir, &meta.binary)?;
  let file_arg = canonicalize_file_arg(&file_path)?;

  let mut cmd = Command::new(&binary_path);
  configure_hidden_cli(&mut cmd);

  for (config_key, cli_flag) in &meta.invoke.config_mapping {
    let value = plugin_config.get(config_key).map(|s| s.trim()).unwrap_or("");
    if value.is_empty() {
      continue;
    }
    cmd.arg(format!("-{cli_flag}")).arg(value);
  }

  for (param_name, param_def) in &action.params {
    let value = match param_def.param_type.as_str() {
      "file" => {
        if param_name != "file" {
          continue;
        }
        Some(format!(
          "{}{}",
          param_def.cli_value_prefix,
          file_arg.to_string_lossy()
        ))
      }
      "string" => {
        if param_name == "key" {
          key
            .as_ref()
            .map(|k| k.trim())
            .filter(|k| !k.is_empty())
            .map(|k| k.to_string())
        } else {
          None
        }
      }
      _ => None,
    };

    if let Some(value) = value {
      if param_def.required && value.trim().is_empty() {
        return Err(format!("缺少必填参数: {param_name}"));
      }
      if !value.is_empty() {
        cmd.arg(format!("-{}", param_def.cli_flag)).arg(value);
      }
    } else if param_def.required && param_def.param_type != "file" {
      return Err(format!("缺少必填参数: {param_name}"));
    }
  }

  let output = cmd
    .output()
    .map_err(|e| format!("启动插件失败: {e}"))?;

  if !output.status.success() {
    let stderr_raw = String::from_utf8_lossy(&output.stderr);
    let stdout_raw = String::from_utf8_lossy(&output.stdout);
    let stderr = stderr_raw.trim();
    let stdout = stdout_raw.trim();
    let detail = if !stderr.is_empty() {
      stderr.to_string()
    } else if !stdout.is_empty() {
      stdout.to_string()
    } else {
      format!("退出码 {}", output.status)
    };
    return Err(detail);
  }

  let stdout_raw = String::from_utf8_lossy(&output.stdout);
  let stderr_raw = String::from_utf8_lossy(&output.stderr);

  if let Ok(url) = parse_upload_url(&stdout_raw) {
    return Ok(url);
  }

  if let Ok(url) = parse_upload_url(&stderr_raw) {
    return Ok(url);
  }

  let stdout = stdout_raw.trim();
  let stderr = stderr_raw.trim();
  let detail = if !stderr.is_empty() {
    stderr.to_string()
  } else if !stdout.is_empty() {
    stdout.to_string()
  } else {
    "插件未返回上传链接".to_string()
  };
  Err(detail)
}

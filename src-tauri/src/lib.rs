mod proxy;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    relative_path: String,
}

#[derive(Serialize)]
pub struct FileSnapshot {
    path: String,
    content: String,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    ".turbo",
    "coverage",
    ".cache",
];

#[tauri::command]
fn read_directory_recursive(root: String, extensions: Vec<String>) -> Result<Vec<FileEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {}", root));
    }

    let mut entries = Vec::new();

    for entry in WalkDir::new(&root_path)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().is_file() {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if extensions.iter().any(|e| e.to_lowercase() == ext_str) {
                    let relative = path
                        .strip_prefix(&root_path)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    entries.push(FileEntry {
                        path: path.to_string_lossy().to_string(),
                        relative_path: relative,
                    });
                }
            }
        }
    }

    Ok(entries)
}

#[tauri::command]
fn read_file_contents(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn snapshot_files(paths: Vec<String>) -> Result<Vec<FileSnapshot>, String> {
    let mut snapshots = Vec::new();
    for path in paths {
        match fs::read_to_string(&path) {
            Ok(content) => snapshots.push(FileSnapshot {
                path: path.clone(),
                content,
            }),
            Err(e) => {
                // Skip files that can't be read (binary, permissions, etc.)
                eprintln!("Warning: could not read {}: {}", path, e);
            }
        }
    }
    Ok(snapshots)
}

#[tauri::command]
fn write_file_contents(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dirs: {}", e))?;
    }
    fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path, e))
}

#[tauri::command]
async fn start_inspector_proxy(dev_server_url: String) -> Result<u16, String> {
    proxy::start_proxy(dev_server_url).await
}

#[tauri::command]
async fn stop_inspector_proxy() -> Result<(), String> {
    proxy::stop_proxy().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_directory_recursive,
            read_file_contents,
            snapshot_files,
            write_file_contents,
            delete_file,
            start_inspector_proxy,
            stop_inspector_proxy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

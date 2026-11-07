use tauri::Manager;

#[tauri::command]
fn eval_on_webview(app: tauri::AppHandle, label: String, script: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.eval(script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("webview {} not found", label))
    }
}

#[tauri::command]
fn place_external_app(app_name: String, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    let script = format!(
        r#"tell application "{}" to activate
delay 0.3
tell application "System Events" to tell process "{}"
  try
    set position of window 1 to {{{}, {}}}
    set size of window 1 to {{{}, {}}}
  end try
end tell"#,
        app_name, app_name, x, y, width, height
    );

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

#[tauri::command]
fn list_installed_apps() -> Result<Vec<String>, String> {
    use std::fs;
    use std::path::Path;

    let mut apps = Vec::new();

    let dirs = [
        "/Applications",
        &format!("{}/Applications", std::env::var("HOME").unwrap_or_default()),
        "/System/Applications",
    ];

    for dir in dirs {
        let path = Path::new(dir);
        if !path.exists() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |ext| ext == "app") {
                    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                        if !name.is_empty() {
                            apps.push(name.to_string());
                        }
                    }
                }
            }
        }
    }

    apps.sort();
    apps.dedup();
    Ok(apps)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            eval_on_webview,
            place_external_app,
            list_installed_apps
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

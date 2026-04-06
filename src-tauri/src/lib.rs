use std::path::Path;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  load_root_env();

  tauri::Builder::default()
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
    .invoke_handler(tauri::generate_handler![
      check_unipile_connection,
      check_gemini_connection
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// Load `.env.local` then `.env` from the project root (parent of `src-tauri/`).
fn load_root_env() {
  let manifest_dir = env!("CARGO_MANIFEST_DIR");
  let root = Path::new(manifest_dir).join("..");
  let _ = dotenvy::from_path(root.join(".env.local"));
  let _ = dotenvy::from_path(root.join(".env"));
}

#[tauri::command]
async fn check_unipile_connection() -> Result<String, String> {
  let api_key =
    std::env::var("UNIPILE_API_KEY").map_err(|_| "UNIPILE_API_KEY is not set".to_string())?;
  let base = std::env::var("UNIPILE_API_URL")
    .unwrap_or_else(|_| "https://api30.unipile.com:16080".to_string());
  let base = base.trim_end_matches('/').to_string();
  let url = format!("{base}/api/v1/accounts");

  let client = reqwest::Client::new();
  let response = client
    .get(&url)
    .header("X-API-KEY", api_key)
    .header("Accept", "application/json")
    .send()
    .await
    .map_err(|e| format!("Unipile request failed: {e}"))?;

  let status = response.status();
  if status.is_success() {
    Ok(format!("Unipile OK ({status})"))
  } else {
    let body = response.text().await.unwrap_or_default();
    Err(format!("Unipile error {status}: {body}"))
  }
}

#[tauri::command]
async fn check_gemini_connection() -> Result<String, String> {
  let key =
    std::env::var("GEMINI_API_KEY").map_err(|_| "GEMINI_API_KEY is not set".to_string())?;

  let client = reqwest::Client::new();
  let response = client
    .get("https://generativelanguage.googleapis.com/v1beta/models")
    .query(&[("key", key.as_str())])
    .send()
    .await
    .map_err(|e| format!("Gemini request failed: {e}"))?;

  let status = response.status();
  if status.is_success() {
    Ok(format!("Gemini OK ({status})"))
  } else {
    let body = response.text().await.unwrap_or_default();
    Err(format!("Gemini error {status}: {body}"))
  }
}

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
      check_gemini_connection,
      fetch_unipile_accounts,
      register_unipile_webhook
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn load_root_env() {
  let manifest_dir = env!("CARGO_MANIFEST_DIR");
  let root = Path::new(manifest_dir).join("..");
  let _ = dotenvy::from_path(root.join(".env.local"));
  let _ = dotenvy::from_path(root.join(".env"));
}

fn unipile_config() -> Result<(String, String), String> {
  let api_key =
    std::env::var("UNIPILE_API_KEY").map_err(|_| "UNIPILE_API_KEY is not set".to_string())?;
  let base = std::env::var("UNIPILE_API_URL")
    .unwrap_or_else(|_| "https://api30.unipile.com:16080".to_string());
  Ok((api_key, base.trim_end_matches('/').to_string()))
}

#[tauri::command]
async fn check_unipile_connection() -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
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

#[derive(serde::Serialize)]
struct UnipileAccount {
  id: String,
  #[serde(rename = "type")]
  account_type: String,
  name: String,
  status: String,
}

#[tauri::command]
async fn fetch_unipile_accounts() -> Result<Vec<UnipileAccount>, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/accounts");

  let client = reqwest::Client::new();
  let response = client
    .get(&url)
    .header("X-API-KEY", &api_key)
    .header("Accept", "application/json")
    .send()
    .await
    .map_err(|e| format!("Unipile request failed: {e}"))?;

  if !response.status().is_success() {
    let body = response.text().await.unwrap_or_default();
    return Err(format!("Unipile error: {body}"));
  }

  let data: serde_json::Value = response.json().await.map_err(|e| format!("Parse error: {e}"))?;

  let items = data
    .as_array()
    .or_else(|| data.get("items").and_then(|v| v.as_array()))
    .cloned()
    .unwrap_or_default();

  let accounts: Vec<UnipileAccount> = items
    .iter()
    .map(|item| UnipileAccount {
      id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
      account_type: item
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string(),
      name: item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string(),
      status: item
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string(),
    })
    .collect();

  Ok(accounts)
}

#[tauri::command]
async fn register_unipile_webhook(webhook_url: String) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/webhooks");

  let webhook_secret = std::env::var("UNIPILE_WEBHOOK_SECRET").unwrap_or_default();

  let mut body = serde_json::json!({
    "request_url": webhook_url,
    "events": ["message_received"],
    "name": "Convolios Inbox",
    "headers": {
      "Content-Type": "application/json"
    }
  });

  if !webhook_secret.is_empty() {
    body["headers"]["Unipile-Auth"] = serde_json::Value::String(webhook_secret);
  }

  let client = reqwest::Client::new();
  let response = client
    .post(&url)
    .header("X-API-KEY", &api_key)
    .header("Content-Type", "application/json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Webhook registration failed: {e}"))?;

  let status = response.status();
  let resp_body = response.text().await.unwrap_or_default();

  if status.is_success() {
    Ok(format!("Webhook registered: {resp_body}"))
  } else {
    Err(format!("Webhook error {status}: {resp_body}"))
  }
}

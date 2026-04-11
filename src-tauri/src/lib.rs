use std::path::Path;
use std::time::Duration;
use tauri::{Manager, State};

struct AppState {
  http: reqwest::Client,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  load_root_env();

  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_zustand::init())
    .plugin(tauri_plugin_deep_link::init())
    .setup(|app| {
      let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(5)
        .build()
        .expect("failed to build HTTP client");
      app.manage(AppState { http: client });

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
      register_unipile_webhook,
      create_connect_link,
      sync_unipile_accounts,
      disconnect_account,
      startup_sync,
      backfill_messages,
      send_message,
      send_attachment,
      send_voice_message,
      add_reaction,
      edit_message,
      fetch_attachment,
      fetch_chat_avatars
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
    .map_err(|_| "UNIPILE_API_URL is not set".to_string())?;
  Ok((api_key, base.trim_end_matches('/').to_string()))
}

async fn fetch_paginated(
  client: &reqwest::Client,
  base_url: &str,
  api_key: &str,
  max_pages: usize,
) -> Result<Vec<serde_json::Value>, String> {
  let mut all_items = Vec::new();
  let mut cursor: Option<String> = None;

  for _ in 0..max_pages {
    let url = match &cursor {
      Some(c) => format!("{base_url}&cursor={c}"),
      None => base_url.to_string(),
    };

    let resp = client.get(&url)
      .header("X-API-KEY", api_key)
      .send()
      .await
      .map_err(|e| format!("fetch failed: {e}"))?;

    if !resp.status().is_success() {
      let status = resp.status();
      let body = resp.text().await.unwrap_or_default();
      return Err(format!("HTTP {status}: {body}"));
    }

    let data: serde_json::Value = resp.json().await
      .map_err(|e| format!("parse: {e}"))?;

    if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
      all_items.extend(items.iter().cloned());
    }

    cursor = data.get("cursor")
      .and_then(|v| v.as_str())
      .filter(|s| !s.is_empty())
      .map(String::from);

    if cursor.is_none() { break; }
  }

  Ok(all_items)
}

#[tauri::command]
async fn check_unipile_connection(state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/accounts");

  let response = state.http
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
async fn check_gemini_connection(state: State<'_, AppState>) -> Result<String, String> {
  let key =
    std::env::var("GEMINI_API_KEY").map_err(|_| "GEMINI_API_KEY is not set".to_string())?;

  let response = state.http
    .get("https://generativelanguage.googleapis.com/v1beta/models")
    .header("x-goog-api-key", &key)
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

#[derive(serde::Serialize, Clone)]
struct UnipileAccount {
  id: String,
  #[serde(rename = "type")]
  account_type: String,
  name: String,
  status: String,
  created_at: String,
  email: Option<String>,
  phone: Option<String>,
  username: Option<String>,
  connection_params: serde_json::Value,
}

#[tauri::command]
async fn fetch_unipile_accounts(state: State<'_, AppState>) -> Result<Vec<UnipileAccount>, String> {
  fetch_accounts_inner(&state.http).await
}

fn str_field(v: &serde_json::Value, path: &[&str]) -> Option<String> {
  let mut cur = v;
  for key in path {
    cur = cur.get(*key)?;
  }
  cur.as_str().map(|s| s.to_string())
}

fn parse_unipile_account(item: &serde_json::Value) -> UnipileAccount {
  let account_type = str_field(item, &["type"]).unwrap_or_else(|| "unknown".into());
  let cp = item.get("connection_params").cloned().unwrap_or(serde_json::Value::Null);
  let type_upper = account_type.to_uppercase();

  let email = str_field(&cp, &["mail", "username"])
    .or_else(|| str_field(&cp, &["mail", "id"]));

  let phone = str_field(&cp, &["im", "phone_number"]);

  let username = match type_upper.as_str() {
    "LINKEDIN" => str_field(&cp, &["im", "publicIdentifier"]),
    "INSTAGRAM" | "TELEGRAM" => str_field(&cp, &["im", "username"]),
    _ => None,
  };

  UnipileAccount {
    id: str_field(item, &["id"]).unwrap_or_default(),
    account_type,
    name: str_field(item, &["name"]).unwrap_or_default(),
    status: item.get("sources")
      .and_then(|v| v.as_array())
      .and_then(|arr| arr.first())
      .and_then(|s| s.get("status"))
      .and_then(|v| v.as_str())
      .or_else(|| item.get("status").and_then(|v| v.as_str()))
      .unwrap_or("unknown")
      .to_string(),
    created_at: str_field(item, &["created_at"]).unwrap_or_default(),
    email,
    phone,
    username,
    connection_params: cp,
  }
}

async fn fetch_accounts_inner(client: &reqwest::Client) -> Result<Vec<UnipileAccount>, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/accounts");

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

  Ok(items.iter().map(parse_unipile_account).collect())
}

#[tauri::command]
async fn register_unipile_webhook(webhook_url: String, state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/webhooks");

  let webhook_secret = std::env::var("UNIPILE_WEBHOOK_SECRET").unwrap_or_default();

  let headers = if webhook_secret.is_empty() {
    serde_json::json!([{"key": "Content-Type", "value": "application/json"}])
  } else {
    serde_json::json!([
      {"key": "x-webhook-secret", "value": webhook_secret}
    ])
  };

  let sources = vec![
    ("messaging", serde_json::json!(["message_received", "message_reaction", "message_read", "message_edited", "message_deleted", "message_delivered"])),
    ("email", serde_json::json!(["mail_received", "mail_sent", "mail_moved"])),
    ("account_status", serde_json::json!(["creation_success", "creation_fail", "reconnected", "error", "credentials"])),
  ];

  let mut created = 0u32;
  for (source, events) in &sources {
    let body = serde_json::json!({
      "request_url": webhook_url,
      "source": source,
      "events": events,
      "name": format!("Convolios {}", source),
      "headers": headers,
    });

    let response = state.http
      .post(&url)
      .header("X-API-KEY", &api_key)
      .header("Content-Type", "application/json")
      .json(&body)
      .send()
      .await
      .map_err(|e| format!("Webhook registration failed: {e}"))?;

    if response.status().is_success() {
      created += 1;
    }
  }

  Ok(format!("Registered {created}/{} webhooks", sources.len()))
}

#[tauri::command]
async fn create_connect_link(
  user_id: String,
  providers: Vec<String>,
  notify_url: String,
  success_redirect_url: Option<String>,
  reconnect_account_id: Option<String>,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/hosted/accounts/link");

  let expires = chrono::Utc::now() + chrono::Duration::hours(1);
  let expires_str = expires.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

  let provider_list: serde_json::Value = if providers.is_empty() || providers.contains(&"*".to_string()) {
    serde_json::Value::String("*".to_string())
  } else {
    serde_json::json!(providers)
  };

  let link_type = if reconnect_account_id.is_some() { "reconnect" } else { "create" };

  let mut body = serde_json::json!({
    "type": link_type,
    "providers": provider_list,
    "api_url": base,
    "expiresOn": expires_str,
    "name": user_id,
    "notify_url": notify_url
  });

  if let Some(ref redirect) = success_redirect_url {
    body["success_redirect_url"] = serde_json::Value::String(redirect.clone());
  }
  if let Some(ref reconnect_id) = reconnect_account_id {
    body["reconnect_account_id"] = serde_json::Value::String(reconnect_id.clone());
  }

  let response = state.http
    .post(&url)
    .header("X-API-KEY", &api_key)
    .header("Content-Type", "application/json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("Create connect link failed: {e}"))?;

  let status = response.status();
  let resp_body = response.text().await.unwrap_or_default();

  if status.is_success() {
    let parsed: serde_json::Value =
      serde_json::from_str(&resp_body).map_err(|e| format!("Parse error: {e}"))?;
    let link = parsed
      .get("url")
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .to_string();
    Ok(link)
  } else {
    Err(format!("Unipile error {status}: {resp_body}"))
  }
}

#[tauri::command]
async fn sync_unipile_accounts(user_id: String, state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let accounts = fetch_accounts_inner(&state.http).await?;

  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let client = &state.http;
  let mut synced = 0u32;
  let mut removed = 0u32;
  let now = chrono::Utc::now().to_rfc3339();

  let (keep, to_remove) = dedupe_accounts(&accounts);

  for dupe in &to_remove {
    let _ = client
      .delete(format!("{base}/api/v1/accounts/{}", dupe.id))
      .header("X-API-KEY", &api_key)
      .send()
      .await;

    let _ = client
      .delete(format!(
        "{supabase_url}/rest/v1/connected_accounts?account_id=eq.{}&user_id=eq.{user_id}",
        dupe.id
      ))
      .header("apikey", &service_key)
      .header("Authorization", format!("Bearer {service_key}"))
      .send()
      .await;

    removed += 1;
  }

  for acc in &keep {
    let channel = channel_from_type(&acc.account_type);
    let display_name = if acc.name.is_empty() { None } else { Some(&acc.name) };
    let is_active = acc.status == "OK" || acc.status == "RUNNING";
    let db_status = if is_active { "active" } else { map_unipile_status(&acc.status) };

    let body = serde_json::json!({
      "user_id": user_id,
      "provider": "unipile",
      "channel": channel,
      "account_id": acc.id,
      "status": db_status,
      "display_name": display_name,
      "email": acc.email,
      "phone": acc.phone,
      "username": acc.username,
      "provider_type": acc.account_type,
      "connection_params": acc.connection_params,
      "last_synced_at": now,
    });

    let resp = client
      .post(format!("{supabase_url}/rest/v1/connected_accounts"))
      .header("apikey", &service_key)
      .header("Authorization", format!("Bearer {service_key}"))
      .header("Content-Type", "application/json")
      .header("Prefer", "resolution=merge-duplicates")
      .json(&body)
      .send()
      .await
      .map_err(|e| format!("Supabase insert failed: {e}"))?;

    if resp.status().is_success() || resp.status().as_u16() == 409 {
      synced += 1;
    }
  }

  let mut msg = format!("Synced {synced} accounts");
  if removed > 0 {
    msg.push_str(&format!(", cleaned up {removed} duplicates"));
  }
  Ok(msg)
}

#[tauri::command]
async fn disconnect_account(
  account_id: String,
  user_id: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;

  let resp = client
    .delete(format!("{base}/api/v1/accounts/{account_id}"))
    .header("X-API-KEY", &api_key)
    .send()
    .await
    .map_err(|e| format!("Unipile delete failed: {e}"))?;

  if !resp.status().is_success() {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    return Err(format!("Unipile delete returned {status}: {body}"));
  }

  client
    .delete(format!(
      "{supabase_url}/rest/v1/connected_accounts?account_id=eq.{account_id}&user_id=eq.{user_id}"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await
    .map_err(|e| format!("Supabase delete failed: {e}"))?;

  Ok("Account disconnected".to_string())
}

#[tauri::command]
async fn startup_sync(user_id: String, state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let client = &state.http;
  let accounts = match fetch_accounts_inner(client).await {
    Ok(a) => a,
    Err(e) => { eprintln!("[startup_sync] account fetch failed: {e}"); return Ok(format!("Skipped: {e}")); }
  };

  let now = chrono::Utc::now().to_rfc3339();
  let mut synced = 0u32;

  let (keep, to_remove) = dedupe_accounts(&accounts);

  for dupe in &to_remove {
    let _ = client.delete(format!("{base}/api/v1/accounts/{}", dupe.id))
      .header("X-API-KEY", &api_key).send().await;
    let _ = client.delete(format!(
      "{supabase_url}/rest/v1/connected_accounts?account_id=eq.{}&user_id=eq.{user_id}", dupe.id
    )).header("apikey", &service_key).header("Authorization", format!("Bearer {service_key}")).send().await;
  }

  for acc in &keep {
    let channel = channel_from_type(&acc.account_type);
    let display_name = if acc.name.is_empty() { None } else { Some(&acc.name) };
    let is_active = acc.status == "OK" || acc.status == "RUNNING";
    let db_status = if is_active { "active" } else { map_unipile_status(&acc.status) };
    let body = serde_json::json!({
      "user_id": user_id, "provider": "unipile", "channel": channel,
      "account_id": acc.id, "status": db_status, "display_name": display_name,
      "email": acc.email, "phone": acc.phone, "username": acc.username,
      "provider_type": acc.account_type, "connection_params": acc.connection_params,
      "last_synced_at": now,
    });
    let resp = client.post(format!("{supabase_url}/rest/v1/connected_accounts"))
      .header("apikey", &service_key).header("Authorization", format!("Bearer {service_key}"))
      .header("Content-Type", "application/json").header("Prefer", "resolution=merge-duplicates")
      .json(&body).send().await;
    if let Ok(r) = resp { if r.status().is_success() || r.status().as_u16() == 409 { synced += 1; } }
  }

  let cutoff = (chrono::Utc::now() - chrono::Duration::hours(24))
    .format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
  let mut msgs_synced = 0u32;

  let active_accounts: Vec<&UnipileAccount> = keep.iter()
    .filter(|a| a.status == "OK" || a.status == "RUNNING")
    .cloned()
    .collect();

  for acc in &active_accounts {
    let channel = channel_from_type(&acc.account_type);
    let chats_url = format!("{base}/api/v1/chats?account_id={}&limit=50&after={cutoff}", acc.id);
    let chats = match fetch_paginated(client, &chats_url, &api_key, 5).await {
      Ok(c) => c,
      Err(_) => continue,
    };

    for chat in &chats {
      let chat_id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
      if chat_id.is_empty() { continue; }

      let is_group = chat.get("type").and_then(|v| v.as_u64()).unwrap_or(0) == 1;
      let msg_type = if is_group { "group" } else { "dm" };
      let chat_name = chat.get("name").and_then(|v| v.as_str()).unwrap_or("");
      let display_name = if !chat_name.is_empty() { chat_name.to_string() } else { "Unknown".to_string() };
      let sender_handle_raw = chat.get("attendee_public_identifier")
        .or(chat.get("attendee_provider_id"))
        .or(chat.get("provider_id"))
        .and_then(|v| v.as_str())
        .unwrap_or(chat_id);
      let sender_handle = normalize_handle(sender_handle_raw, channel);

      let person_resp = client
        .post(format!("{supabase_url}/rest/v1/rpc/backfill_find_or_create_person"))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
          "p_user_id": user_id, "p_channel": channel,
          "p_handle": sender_handle, "p_display_name": display_name,
          "p_unipile_account_id": acc.id
        }))
        .send().await;

      let (person_id, identity_id) = match person_resp {
        Ok(r) if r.status().is_success() => {
          let b: serde_json::Value = r.json().await.unwrap_or_default();
          let pid = b.get("person_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
          let iid = b.get("identity_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
          if pid.is_empty() { continue; }
          (pid, iid)
        }
        _ => continue,
      };

      let attendee_map: std::collections::HashMap<String, String> = if is_group {
        let att_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
        match client.get(&att_url).header("X-API-KEY", &api_key).send().await {
          Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            body.get("items").and_then(|v| v.as_array()).map(|arr| {
              arr.iter().filter_map(|a| {
                let id = a.get("id").and_then(|v| v.as_str())?;
                let name = a.get("name").and_then(|v| v.as_str())?;
                if name.is_empty() { return None; }
                Some((id.to_string(), name.to_string()))
              }).collect()
            }).unwrap_or_default()
          }
          _ => std::collections::HashMap::new(),
        }
      } else {
        std::collections::HashMap::new()
      };

      let msgs_url = format!("{base}/api/v1/chats/{chat_id}/messages?limit=20");
      let messages = match fetch_paginated(client, &msgs_url, &api_key, 1).await {
        Ok(m) => m,
        Err(_) => continue,
      };

      for msg in &messages {
        let external_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if external_id.is_empty() { continue; }
        let timestamp = msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if timestamp.is_empty() { continue; }

        let is_sender = msg.get("is_sender")
          .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
          .unwrap_or(false);
        let direction = if is_sender { "outbound" } else { "inbound" };
        let body_text = msg.get("text").and_then(|v| v.as_str());

        let attachments = msg.get("attachments")
          .and_then(|v| v.as_array())
          .map(|arr| serde_json::Value::Array(arr.clone()))
          .unwrap_or_else(|| serde_json::json!([]));

        let sender_name: Option<String> = if is_group {
          msg.get("sender_attendee_id")
            .and_then(|v| v.as_str())
            .and_then(|id| attendee_map.get(id))
            .cloned()
            .or_else(|| {
              msg.get("original")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .and_then(|o| o.get("pushName").and_then(|v| v.as_str()).map(String::from))
            })
            .or_else(|| {
              msg.get("sender_public_identifier")
                .and_then(|v| v.as_str())
                .map(|s| s.replace("@s.whatsapp.net", "").replace("@lid", ""))
                .map(|s| if s.chars().all(|c| c.is_ascii_digit()) { format!("+{s}") } else { s })
            })
        } else {
          None
        };

        let row = serde_json::json!({
          "user_id": user_id, "person_id": person_id,
          "identity_id": if identity_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(identity_id.clone()) },
          "external_id": external_id, "channel": channel,
          "direction": direction, "message_type": msg_type,
          "body_text": body_text, "attachments": attachments,
          "thread_id": chat_id, "sent_at": timestamp,
          "sender_name": sender_name,
          "triage": "unclassified", "unipile_account_id": acc.id,
        });

        let insert = client
          .post(format!("{supabase_url}/rest/v1/messages?on_conflict=external_id"))
          .header("apikey", &service_key).header("Authorization", format!("Bearer {service_key}"))
          .header("Content-Type", "application/json").header("Prefer", "resolution=merge-duplicates")
          .json(&row).send().await;
        if let Ok(r) = insert {
          if r.status().is_success() || r.status().as_u16() == 409 { msgs_synced += 1; }
        }
      }
    }
  }

  let mut result = format!("Synced {synced} accounts");
  if !to_remove.is_empty() { result.push_str(&format!(", cleaned {}", to_remove.len())); }
  if msgs_synced > 0 { result.push_str(&format!(", backfilled {msgs_synced} msgs (24h)")); }
  eprintln!("[startup_sync] {result}");
  Ok(result)
}

fn dedupe_accounts<'a>(accounts: &'a [UnipileAccount]) -> (Vec<&'a UnipileAccount>, Vec<&'a UnipileAccount>) {
  let mut keep: Vec<&UnipileAccount> = Vec::new();
  let mut to_remove: Vec<&UnipileAccount> = Vec::new();
  let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

  for acc in accounts {
    let key = format!("{}:{}", channel_from_type(&acc.account_type), acc.name.to_lowercase());
    if let Some(&idx) = seen.get(&key) {
      let existing = keep[idx];
      let acc_active = acc.status == "OK" || acc.status == "RUNNING";
      let existing_active = existing.status == "OK" || existing.status == "RUNNING";
      if (acc_active && !existing_active) || (acc_active == existing_active && acc.created_at > existing.created_at) {
        to_remove.push(existing);
        keep[idx] = acc;
      } else {
        to_remove.push(acc);
      }
    } else {
      seen.insert(key, keep.len());
      keep.push(acc);
    }
  }

  (keep, to_remove)
}

fn channel_from_type(t: &str) -> &'static str {
  match t.to_uppercase().as_str() {
    "LINKEDIN" => "linkedin",
    "WHATSAPP" => "whatsapp",
    "INSTAGRAM" => "instagram",
    "TELEGRAM" => "telegram",
    "MAIL" | "GMAIL" | "GOOGLE" | "GOOGLE_OAUTH" => "email",
    "OUTLOOK" | "MICROSOFT" => "email",
    "IMAP" => "email",
    _ => "unknown",
  }
}

fn map_unipile_status(raw: &str) -> &'static str {
  match raw.to_uppercase().as_str() {
    "OK" | "RUNNING" => "active",
    "CREDENTIALS" => "credentials",
    "ERROR" => "error",
    _ => "disconnected",
  }
}

fn normalize_handle(raw: &str, channel: &str) -> String {
  let mut h = raw
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .replace("@c.us", "")
    .trim()
    .to_string();
  if channel == "whatsapp" && h.chars().all(|c| c.is_ascii_digit()) && !h.is_empty() {
    h = format!("+{h}");
  }
  if channel == "linkedin" {
    if let Some(stripped) = h.strip_prefix("https://www.linkedin.com/in/") {
      h = stripped.trim_end_matches('/').to_string();
    } else if let Some(stripped) = h.strip_prefix("https://linkedin.com/in/") {
      h = stripped.trim_end_matches('/').to_string();
    }
  }
  h.to_lowercase()
}

#[tauri::command]
async fn backfill_messages(user_id: String, state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let client = &state.http;
  let accounts = fetch_accounts_inner(client).await?;

  let mut total_messages = 0u32;
  let mut total_chats = 0u32;
  let mut errors: Vec<String> = Vec::new();

  for acc in &accounts {
    let channel = channel_from_type(&acc.account_type);

    let chats_base_url = format!("{base}/api/v1/chats?account_id={}&limit=100", acc.id);
    let chats = match fetch_paginated(client, &chats_base_url, &api_key, 50).await {
      Ok(c) => c,
      Err(e) => { errors.push(format!("chats fetch: {e}")); continue; }
    };

    for chat in &chats {
      let chat_id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
      if chat_id.is_empty() { continue; }

      let is_group = chat.get("type").and_then(|v| v.as_u64()).unwrap_or(0) == 1;
      let chat_name = chat.get("name").and_then(|v| v.as_str()).unwrap_or("");
      let msg_type = if is_group { "group" } else { "dm" };

      let display_name: String;
      let mut sender_handle: String;
      let mut dm_attendee_id: Option<String> = None;
      let mut dm_picture_url: Option<String> = None;

      if is_group {
        display_name = if chat_name.is_empty() { "Group Chat".to_string() } else { chat_name.to_string() };
        sender_handle = chat.get("provider_id")
          .and_then(|v| v.as_str())
          .unwrap_or(chat_id)
          .to_string();
      } else {
        let attendees_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
        let all_attendees: Vec<serde_json::Value> = match client.get(&attendees_url).header("X-API-KEY", &api_key).send().await {
          Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            body.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default()
          }
          _ => Vec::new(),
        };

        let other_attendee = all_attendees.iter()
          .find(|a| {
            let is_self = a.get("is_self")
              .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
              .unwrap_or(false);
            !is_self
          });
        let attendee_info = other_attendee.or_else(|| all_attendees.first());

        let att_name = attendee_info
          .and_then(|a| a.get("name").and_then(|v| v.as_str()))
          .unwrap_or("");

        if let Some(other) = other_attendee {
          dm_attendee_id = other.get("id").and_then(|v| v.as_str()).map(String::from);
          dm_picture_url = other.get("picture_url")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        }

        let att_phone = attendee_info
          .and_then(|a| a.get("specifics"))
          .and_then(|s| s.get("phone_number"))
          .and_then(|v| v.as_str())
          .unwrap_or("");

        let pub_id = chat
          .get("attendee_public_identifier")
          .and_then(|v| v.as_str())
          .unwrap_or("");

        display_name = if !att_name.is_empty() && att_name != "Unknown" {
          att_name.to_string()
        } else if !chat_name.is_empty() {
          chat_name.to_string()
        } else if !att_phone.is_empty() {
          att_phone.to_string()
        } else if !pub_id.is_empty() {
          pub_id.to_string()
        } else {
          "Unknown".to_string()
        };

        sender_handle = chat
          .get("attendee_public_identifier")
          .or(chat.get("attendee_provider_id"))
          .or(chat.get("provider_id"))
          .and_then(|v| v.as_str())
          .unwrap_or(chat_id)
          .to_string();
        sender_handle = normalize_handle(&sender_handle, channel);
      }

      let person_resp = client
        .post(format!("{supabase_url}/rest/v1/rpc/backfill_find_or_create_person"))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
          "p_user_id": user_id,
          "p_channel": channel,
          "p_handle": sender_handle,
          "p_display_name": display_name,
          "p_unipile_account_id": acc.id
        }))
        .send()
        .await;

      let (person_id, identity_id) = match person_resp {
        Ok(r) if r.status().is_success() => {
          let body: serde_json::Value = r.json().await.unwrap_or_default();
          let pid = body.get("person_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
          let iid = body.get("identity_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
          if pid.is_empty() {
            errors.push(format!("empty person_id for chat {chat_id}"));
            continue;
          }
          (pid, iid)
        }
        Ok(r) => {
          let status = r.status();
          let body = r.text().await.unwrap_or_default();
          errors.push(format!("person rpc {status}: {body}"));
          continue;
        }
        Err(e) => { errors.push(format!("person rpc: {e}")); continue; }
      };

      if !is_group {
        if let Some(att_id) = &dm_attendee_id {
          let mut avatar_data: Option<String> = None;

          if let Some(ref pic_url) = dm_picture_url {
            if let Ok(pic_resp) = client.get(pic_url).send().await {
              if pic_resp.status().is_success() {
                let ct = pic_resp.headers().get("content-type")
                  .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
                if let Ok(bytes) = pic_resp.bytes().await {
                  if !bytes.is_empty() {
                    let b64 = base64_encode(&bytes);
                    avatar_data = Some(format!("data:{ct};base64,{b64}"));
                  }
                }
              }
            }
          }

          if avatar_data.is_none() {
            let pic_url = format!("{base}/api/v1/chat_attendees/{att_id}/picture");
            if let Ok(pic_resp) = client.get(&pic_url).header("X-API-KEY", &api_key).send().await {
              if pic_resp.status().is_success() {
                let ct = pic_resp.headers().get("content-type")
                  .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
                if let Ok(bytes) = pic_resp.bytes().await {
                  if !bytes.is_empty() {
                    let b64 = base64_encode(&bytes);
                    avatar_data = Some(format!("data:{ct};base64,{b64}"));
                  }
                }
              }
            }
          }

          if let Some(data_uri) = avatar_data {
            let _ = client
              .patch(format!("{supabase_url}/rest/v1/persons?id=eq.{person_id}"))
              .header("apikey", &service_key)
              .header("Authorization", format!("Bearer {service_key}"))
              .header("Content-Type", "application/json")
              .json(&serde_json::json!({ "avatar_url": data_uri }))
              .send()
              .await;
          }
        }
      }

      let chat_folder = chat.get("folder").and_then(|v| v.as_str()).unwrap_or("");

      let msgs_base_url = format!("{base}/api/v1/chats/{chat_id}/messages?limit=100");

      let attendee_map: std::collections::HashMap<String, String> = if is_group {
        let att_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
        match client.get(&att_url).header("X-API-KEY", &api_key).send().await {
          Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            body.get("items").and_then(|v| v.as_array()).map(|arr| {
              arr.iter().filter_map(|a| {
                let id = a.get("id").and_then(|v| v.as_str())?;
                let name = a.get("name").and_then(|v| v.as_str())?;
                if name.is_empty() { return None; }
                Some((id.to_string(), name.to_string()))
              }).collect()
            }).unwrap_or_default()
          }
          _ => std::collections::HashMap::new(),
        }
      } else {
        std::collections::HashMap::new()
      };

      let messages = match fetch_paginated(client, &msgs_base_url, &api_key, 20).await {
        Ok(m) => m,
        Err(e) => { errors.push(format!("msgs fetch {chat_id}: {e}")); continue; }
      };

      for msg in &messages {
        let external_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if external_id.is_empty() { continue; }

        let timestamp = msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if timestamp.is_empty() { continue; }

        let body_text = msg.get("text").and_then(|v| v.as_str());

        let is_sender = msg.get("is_sender")
          .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
          .unwrap_or(false);

        let direction = if is_sender { "outbound" } else { "inbound" };

        let attachments = msg.get("attachments")
          .and_then(|v| v.as_array())
          .map(|arr| serde_json::Value::Array(arr.clone()))
          .unwrap_or_else(|| serde_json::json!([]));

        let sender_name: Option<String> = msg.get("sender_attendee_id")
          .and_then(|v| v.as_str())
          .and_then(|id| attendee_map.get(id))
          .cloned()
          .or_else(|| {
            msg.get("original")
              .and_then(|v| v.as_str())
              .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
              .and_then(|o| o.get("pushName").and_then(|v| v.as_str()).map(String::from))
          })
          .or_else(|| {
            msg.get("sender_public_identifier")
              .and_then(|v| v.as_str())
              .map(|s| s.replace("@s.whatsapp.net", "").replace("@lid", ""))
              .map(|s| if s.chars().all(|c| c.is_ascii_digit()) { format!("+{s}") } else { s })
          });

        let hidden = msg.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
        let is_event = msg.get("is_event").and_then(|v| v.as_bool()).unwrap_or(false);
        let event_type_val = msg.get("event_type").and_then(|v| v.as_str());
        let seen_val = msg.get("seen").and_then(|v| v.as_bool()).unwrap_or(false);
        let seen_by = msg.get("seen_by").filter(|v| v.is_object()).cloned();
        let delivered_val = msg.get("delivered").and_then(|v| v.as_bool()).unwrap_or(false);
        let edited_val = msg.get("edited").and_then(|v| v.as_bool()).unwrap_or(false);
        let deleted_val = msg.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false);
        let msg_provider_id = msg.get("provider_id").and_then(|v| v.as_str());
        let msg_chat_provider_id = msg.get("chat_provider_id").and_then(|v| v.as_str());
        let quoted_text = msg.get("quoted").and_then(|q| q.get("text")).and_then(|v| v.as_str());
        let quoted_sender = msg.get("quoted").and_then(|q| q.get("sender_name")).and_then(|v| v.as_str());
        let reactions = msg.get("reactions").filter(|v| v.is_array()).cloned().unwrap_or(serde_json::json!([]));

        let row = serde_json::json!({
          "user_id": user_id,
          "person_id": person_id,
          "identity_id": if identity_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(identity_id.clone()) },
          "external_id": external_id,
          "channel": channel,
          "direction": direction,
          "message_type": msg_type,
          "body_text": body_text,
          "attachments": attachments,
          "thread_id": chat_id,
          "sent_at": timestamp,
          "sender_name": sender_name,
          "reactions": reactions,
          "triage": "unclassified",
          "unipile_account_id": acc.id,
          "hidden": hidden,
          "is_event": is_event,
          "event_type": event_type_val,
          "seen": seen_val,
          "seen_by": seen_by,
          "delivered": delivered_val,
          "edited": edited_val,
          "deleted": deleted_val,
          "provider_id": msg_provider_id,
          "chat_provider_id": msg_chat_provider_id,
          "quoted_text": quoted_text,
          "quoted_sender": quoted_sender,
          "folder": if chat_folder.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(chat_folder.to_string()) },
          "read_at": if !is_sender && seen_val { serde_json::Value::String(chrono::Utc::now().to_rfc3339()) } else { serde_json::Value::Null }
        });

        let insert_resp = client
          .post(format!("{supabase_url}/rest/v1/messages?on_conflict=external_id"))
          .header("apikey", &service_key)
          .header("Authorization", format!("Bearer {service_key}"))
          .header("Content-Type", "application/json")
          .header("Prefer", "resolution=merge-duplicates")
          .json(&row)
          .send()
          .await;

        match insert_resp {
          Ok(r) if r.status().is_success() || r.status().as_u16() == 409 => {
            total_messages += 1;
          }
          Ok(r) => {
            let body = r.text().await.unwrap_or_default();
            errors.push(format!("insert msg: {body}"));
          }
          Err(e) => { errors.push(format!("insert msg: {e}")); }
        }
      }

      patch_stale_thread_ids(client, &supabase_url, &service_key, &person_id, channel, chat_id).await;
      total_chats += 1;
    }
  }

  let mut result = format!("Backfilled {} messages from {} chats", total_messages, total_chats);
  if !errors.is_empty() {
    let first_errors: Vec<&str> = errors.iter().take(3).map(|s| s.as_str()).collect();
    result.push_str(&format!(" (errors: {})", first_errors.join("; ")));
  }
  Ok(result)
}

#[tauri::command]
async fn send_message(
  chat_id: String,
  text: String,
  user_id: String,
  person_id: String,
  channel: String,
  message_type: String,
  account_id: Option<String>,
  quote_id: Option<String>,
  typing_duration: Option<String>,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let client = &state.http;

  let try_send = |cid: &str, aid: Option<&str>| {
    let url = format!("{base}/api/v1/chats/{cid}/messages");
    let mut form = reqwest::multipart::Form::new().text("text", text.clone());
    if let Some(a) = aid { if !a.is_empty() { form = form.text("account_id", a.to_string()); } }
    if let Some(ref qid) = quote_id { if !qid.is_empty() { form = form.text("quote_id", qid.clone()); } }
    if let Some(ref td) = typing_duration { if !td.is_empty() { form = form.text("typing_duration", td.clone()); } }
    client.post(url).header("X-API-KEY", &api_key).multipart(form).send()
  };

  let response = try_send(&chat_id, account_id.as_deref()).await
    .map_err(|e| format!("Send failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();

  let (final_chat_id, final_body, final_account_id) = if status.as_u16() == 404 {
    eprintln!("[send_message] chat {chat_id} returned 404, looking up current chat for person {person_id}");
    match resolve_chat(client, &api_key, &base, &user_id, &person_id, &channel).await {
      Ok((new_cid, new_aid)) => {
        let r2 = try_send(&new_cid, Some(&new_aid)).await
          .map_err(|e| format!("Retry send failed: {e}"))?;
        let s2 = r2.status();
        let b2 = r2.text().await.unwrap_or_default();
        if !s2.is_success() {
          return Err(format!("Send error {s2}: {b2}"));
        }
        (new_cid, b2, Some(new_aid))
      }
      Err(e) => return Err(format!("Chat not found for this contact. Try pulling history first. ({e})")),
    }
  } else if !status.is_success() {
    return Err(format!("Send error {status}: {body}"));
  } else {
    (chat_id.clone(), body, account_id.clone())
  };

  let resp: serde_json::Value = serde_json::from_str(&final_body).unwrap_or_default();
  let external_id = resp.get("message_id")
    .or_else(|| resp.get("id"))
    .and_then(|v| v.as_str())
    .unwrap_or("");

  persist_outbound(
    &state.http, &user_id, &person_id, &channel, &message_type,
    &text, &final_chat_id, external_id, &serde_json::json!([]),
    final_account_id.as_deref(),
  ).await.unwrap_or_else(|e| eprintln!("[send_message] persist warning: {e}"));

  Ok(final_body)
}

async fn resolve_chat(
  client: &reqwest::Client,
  api_key: &str,
  base: &str,
  user_id: &str,
  person_id: &str,
  channel: &str,
) -> Result<(String, String), String> {
  let sb_url = std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let sb_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY").map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let ident_url = format!(
    "{sb_url}/rest/v1/identities?select=handle,channel&person_id=eq.{person_id}&channel=eq.{channel}&handle=not.like.*%40g.us&limit=1"
  );
  let ident_resp = client.get(&ident_url)
    .header("apikey", &sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .send().await.map_err(|e| format!("identity lookup: {e}"))?;
  let ident_body: serde_json::Value = ident_resp.json().await.unwrap_or_default();
  let handle = ident_body.as_array()
    .and_then(|arr| arr.first())
    .and_then(|row| row.get("handle"))
    .and_then(|v| v.as_str())
    .ok_or_else(|| "No identity handle found".to_string())?;

  let accts_url = format!(
    "{sb_url}/rest/v1/connected_accounts?select=account_id&channel=eq.{channel}&status=eq.active&user_id=eq.{user_id}"
  );
  let accts_resp = client.get(&accts_url)
    .header("apikey", &sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .send().await.map_err(|e| format!("accounts lookup: {e}"))?;
  let accts_body: serde_json::Value = accts_resp.json().await.unwrap_or_default();
  let account_ids: Vec<&str> = accts_body.as_array()
    .map(|arr| arr.iter().filter_map(|r| r.get("account_id").and_then(|v| v.as_str())).collect())
    .unwrap_or_default();

  if account_ids.is_empty() {
    return Err("No active accounts for this channel".to_string());
  }

  for aid in &account_ids {
    let search_url = format!(
      "{base}/api/v1/chats?account_id={aid}&attendees_identifier={handle}&limit=1",
      handle = urlencoding::encode(handle),
    );
    let resp = client.get(&search_url)
      .header("X-API-KEY", api_key)
      .send().await;
    if let Ok(r) = resp {
      if r.status().is_success() {
        let body: serde_json::Value = r.json().await.unwrap_or_default();
        if let Some(chat_id) = body.get("items")
          .and_then(|v| v.as_array())
          .and_then(|arr| arr.first())
          .and_then(|c| c.get("id"))
          .and_then(|v| v.as_str())
        {
          eprintln!("[resolve_chat] found chat {chat_id} on account {aid} for handle {handle}");
          patch_stale_thread_ids(client, &sb_url, &sb_key, person_id, channel, chat_id).await;
          return Ok((chat_id.to_string(), aid.to_string()));
        }
      }
    }
  }

  Err(format!("No chat found for handle {handle} on any active account"))
}

async fn patch_stale_thread_ids(
  client: &reqwest::Client,
  sb_url: &str,
  sb_key: &str,
  person_id: &str,
  channel: &str,
  new_thread_id: &str,
) {
  let encoded_tid = urlencoding::encode(new_thread_id);
  let url = format!(
    "{sb_url}/rest/v1/messages?person_id=eq.{person_id}&channel=eq.{channel}&thread_id=neq.{encoded_tid}",
  );
  let _ = client
    .patch(&url)
    .header("apikey", sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({ "thread_id": new_thread_id }))
    .send()
    .await;
}

#[tauri::command]
async fn send_attachment(
  chat_id: String,
  text: Option<String>,
  file_name: String,
  file_data: String,
  mime_type: String,
  user_id: String,
  person_id: String,
  channel: String,
  message_type: String,
  account_id: Option<String>,
  quote_id: Option<String>,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let client = &state.http;

  let raw = base64::Engine::decode(&base64_engine(), &file_data)
    .map_err(|e| format!("base64 decode: {e}"))?;

  let body_text = text.clone().unwrap_or_default();

  let build_form = |raw_bytes: Vec<u8>, aid: Option<&str>| -> Result<reqwest::multipart::Form, String> {
    let file_part = reqwest::multipart::Part::bytes(raw_bytes)
      .file_name(file_name.clone())
      .mime_str(&mime_type)
      .map_err(|e| format!("mime: {e}"))?;
    let mut form = reqwest::multipart::Form::new().part("attachments", file_part);
    if !body_text.is_empty() { form = form.text("text", body_text.clone()); }
    if let Some(a) = aid { if !a.is_empty() { form = form.text("account_id", a.to_string()); } }
    if let Some(ref qid) = quote_id { if !qid.is_empty() { form = form.text("quote_id", qid.clone()); } }
    Ok(form)
  };

  let form = build_form(raw.clone(), account_id.as_deref())?;
  let url = format!("{base}/api/v1/chats/{chat_id}/messages");
  let response = client.post(&url).header("X-API-KEY", &api_key).multipart(form).send().await
    .map_err(|e| format!("Send attachment failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();

  let (final_chat_id, final_body, final_account_id) = if status.as_u16() == 404 {
    eprintln!("[send_attachment] chat {chat_id} returned 404, resolving...");
    match resolve_chat(client, &api_key, &base, &user_id, &person_id, &channel).await {
      Ok((new_cid, new_aid)) => {
        let retry_form = build_form(raw, Some(&new_aid))?;
        let retry_url = format!("{base}/api/v1/chats/{new_cid}/messages");
        let r2 = client.post(&retry_url).header("X-API-KEY", &api_key).multipart(retry_form).send().await
          .map_err(|e| format!("Retry send attachment failed: {e}"))?;
        let s2 = r2.status();
        let b2 = r2.text().await.unwrap_or_default();
        if !s2.is_success() {
          return Err(format!("Send attachment error {s2}: {b2}"));
        }
        (new_cid, b2, Some(new_aid))
      }
      Err(e) => return Err(format!("Chat not found for this contact. Try pulling history first. ({e})")),
    }
  } else if !status.is_success() {
    return Err(format!("Send attachment error {status}: {body}"));
  } else {
    (chat_id.clone(), body, account_id.clone())
  };

  let resp: serde_json::Value = serde_json::from_str(&final_body).unwrap_or_default();
  let external_id = resp.get("message_id")
    .or_else(|| resp.get("id"))
    .and_then(|v| v.as_str())
    .unwrap_or("");

  let att_json = serde_json::json!([{ "name": file_name, "mimetype": mime_type }]);
  let display_text = if body_text.is_empty() { String::new() } else { body_text };

  persist_outbound(
    &state.http, &user_id, &person_id, &channel, &message_type,
    &display_text, &final_chat_id, external_id, &att_json, final_account_id.as_deref(),
  ).await.unwrap_or_else(|e| eprintln!("[send_attachment] persist warning: {e}"));

  Ok(final_body)
}

#[tauri::command]
async fn add_reaction(
  message_id: String,
  reaction: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/messages/{message_id}/reaction");

  let response = state.http
    .post(&url)
    .header("X-API-KEY", &api_key)
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({ "reaction": reaction }))
    .send()
    .await
    .map_err(|e| format!("Reaction failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();
  if !status.is_success() {
    return Err(format!("Reaction error {status}: {body}"));
  }
  Ok(body)
}

#[tauri::command]
async fn edit_message(
  message_id: String,
  text: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/messages/{message_id}");

  let response = state.http
    .patch(&url)
    .header("X-API-KEY", &api_key)
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({ "text": text }))
    .send()
    .await
    .map_err(|e| format!("Edit failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();
  if !status.is_success() {
    return Err(format!("Edit error {status}: {body}"));
  }
  Ok(body)
}

#[tauri::command]
async fn send_voice_message(
  chat_id: String,
  voice_data: String,
  voice_mime: String,
  user_id: String,
  person_id: String,
  channel: String,
  message_type: String,
  account_id: Option<String>,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let client = &state.http;

  let raw = base64::Engine::decode(&base64_engine(), &voice_data)
    .map_err(|e| format!("base64 decode: {e}"))?;

  let ext = if voice_mime.contains("mp4") || voice_mime.contains("m4a") { "m4a" }
    else if voice_mime.contains("ogg") { "ogg" }
    else { "mp3" };

  let build_form = |raw_bytes: Vec<u8>, aid: Option<&str>| -> Result<reqwest::multipart::Form, String> {
    let voice_part = reqwest::multipart::Part::bytes(raw_bytes)
      .file_name(format!("voice.{ext}"))
      .mime_str(&voice_mime)
      .map_err(|e| format!("mime: {e}"))?;
    let mut form = reqwest::multipart::Form::new().part("voice_message", voice_part);
    if let Some(a) = aid { if !a.is_empty() { form = form.text("account_id", a.to_string()); } }
    Ok(form)
  };

  let form = build_form(raw.clone(), account_id.as_deref())?;
  let url = format!("{base}/api/v1/chats/{chat_id}/messages");
  let response = client.post(&url).header("X-API-KEY", &api_key).multipart(form).send().await
    .map_err(|e| format!("Voice send failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();

  let (final_chat_id, final_body, final_account_id) = if status.as_u16() == 404 {
    eprintln!("[send_voice] chat {chat_id} returned 404, resolving...");
    match resolve_chat(client, &api_key, &base, &user_id, &person_id, &channel).await {
      Ok((new_cid, new_aid)) => {
        let retry_form = build_form(raw, Some(&new_aid))?;
        let retry_url = format!("{base}/api/v1/chats/{new_cid}/messages");
        let r2 = client.post(&retry_url).header("X-API-KEY", &api_key).multipart(retry_form).send().await
          .map_err(|e| format!("Retry voice send failed: {e}"))?;
        let s2 = r2.status();
        let b2 = r2.text().await.unwrap_or_default();
        if !s2.is_success() {
          return Err(format!("Voice send error {s2}: {b2}"));
        }
        (new_cid, b2, Some(new_aid))
      }
      Err(e) => return Err(format!("Chat not found for this contact. Try pulling history first. ({e})")),
    }
  } else if !status.is_success() {
    return Err(format!("Voice send error {status}: {body}"));
  } else {
    (chat_id.clone(), body, account_id.clone())
  };

  let resp: serde_json::Value = serde_json::from_str(&final_body).unwrap_or_default();
  let external_id = resp.get("message_id")
    .or_else(|| resp.get("id"))
    .and_then(|v| v.as_str())
    .unwrap_or("");

  let att_json = serde_json::json!([{ "type": "ptt", "mimetype": voice_mime }]);
  persist_outbound(
    &state.http, &user_id, &person_id, &channel, &message_type,
    "", &final_chat_id, external_id, &att_json, final_account_id.as_deref(),
  ).await.unwrap_or_else(|e| eprintln!("[send_voice] persist warning: {e}"));

  Ok(final_body)
}

async fn persist_outbound(
  client: &reqwest::Client,
  user_id: &str,
  person_id: &str,
  channel: &str,
  message_type: &str,
  body_text: &str,
  thread_id: &str,
  external_id: &str,
  attachments: &serde_json::Value,
  unipile_account_id: Option<&str>,
) -> Result<(), String> {
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let now = chrono::Utc::now();
  let now_str = now.to_rfc3339();

  let window_start = (now - chrono::Duration::seconds(30)).to_rfc3339();
  let body_filter = if body_text.is_empty() {
    "is.null".to_string()
  } else {
    let escaped = body_text.replace('\\', "\\\\").replace('"', "\\\"");
    format!("eq.\"{escaped}\"")
  };

  let dedup_resp = client
    .get(format!("{supabase_url}/rest/v1/messages"))
    .query(&[
      ("select", "id"),
      ("person_id", &format!("eq.{person_id}") as &str),
      ("user_id", &format!("eq.{user_id}") as &str),
      ("direction", "eq.outbound"),
      ("body_text", body_filter.as_str()),
      ("sent_at", &format!("gte.{window_start}") as &str),
      ("limit", "1"),
    ])
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await;

  if let Ok(resp) = dedup_resp {
    if resp.status().is_success() {
      if let Ok(rows) = resp.json::<Vec<serde_json::Value>>().await {
        if !rows.is_empty() {
          return Ok(());
        }
      }
    }
  }

  let ext_id = if external_id.is_empty() {
    serde_json::Value::Null
  } else {
    serde_json::Value::String(external_id.to_string())
  };

  let row = serde_json::json!({
    "user_id": user_id,
    "person_id": person_id,
    "channel": channel,
    "direction": "outbound",
    "message_type": message_type,
    "body_text": if body_text.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(body_text.to_string()) },
    "attachments": attachments,
    "thread_id": thread_id,
    "sent_at": now_str,
    "triage": "unclassified",
    "external_id": ext_id,
    "unipile_account_id": unipile_account_id,
  });

  let url = if external_id.is_empty() {
    format!("{supabase_url}/rest/v1/messages")
  } else {
    format!("{supabase_url}/rest/v1/messages?on_conflict=external_id")
  };

  let resp = client
    .post(&url)
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .header("Prefer", "resolution=merge-duplicates,return=minimal")
    .json(&row)
    .send()
    .await
    .map_err(|e| format!("Failed to persist outbound message: {e}"))?;

  if !resp.status().is_success() && resp.status().as_u16() != 409 {
    let s = resp.status();
    let b = resp.text().await.unwrap_or_default();
    return Err(format!("Persist outbound failed ({s}): {b}"));
  }

  Ok(())
}

#[tauri::command]
async fn fetch_attachment(message_id: String, attachment_id: String, state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let url = format!("{base}/api/v1/messages/{message_id}/attachments/{attachment_id}");

  let response = state.http
    .get(&url)
    .header("X-API-KEY", &api_key)
    .send()
    .await
    .map_err(|e| format!("Attachment fetch failed: {e}"))?;

  if !response.status().is_success() {
    return Ok(String::new());
  }

  let content_type = response
    .headers()
    .get("content-type")
    .and_then(|v| v.to_str().ok())
    .unwrap_or("application/octet-stream")
    .to_string();

  let bytes = response.bytes().await.map_err(|e| format!("Read error: {e}"))?;
  let b64 = base64_encode(&bytes);
  Ok(format!("data:{content_type};base64,{b64}"))
}

#[tauri::command]
async fn fetch_chat_avatars(
  chat_id: String,
  state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
  let (api_key, base) = unipile_config()?;
  let client = &state.http;

  let att_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
  let resp = client.get(&att_url).header("X-API-KEY", &api_key).send().await
    .map_err(|e| format!("attendees fetch: {e}"))?;

  if !resp.status().is_success() {
    return Ok(std::collections::HashMap::new());
  }

  let body: serde_json::Value = resp.json().await
    .unwrap_or_else(|_| serde_json::json!({"items": []}));
  let items = body.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

  let mut result = std::collections::HashMap::new();

  for att in &items {
    let att_name = att.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let att_id = att.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if att_name.is_empty() || att_id.is_empty() { continue; }
    let is_self = att.get("is_self")
      .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
      .unwrap_or(false);
    if is_self { continue; }

    if let Some(pic_url) = att.get("picture_url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
      if let Ok(pic_resp) = client.get(pic_url).send().await {
        if pic_resp.status().is_success() {
          let ct = pic_resp.headers().get("content-type")
            .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
          if let Ok(bytes) = pic_resp.bytes().await {
            if !bytes.is_empty() {
              let b64 = base64_encode(&bytes);
              result.insert(att_name.clone(), format!("data:{ct};base64,{b64}"));
              continue;
            }
          }
        }
      }
    }

    let pic_url = format!("{base}/api/v1/chat_attendees/{att_id}/picture");
    if let Ok(pic_resp) = client.get(&pic_url).header("X-API-KEY", &api_key).send().await {
      if pic_resp.status().is_success() {
        let ct = pic_resp.headers().get("content-type")
          .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        if let Ok(bytes) = pic_resp.bytes().await {
          if !bytes.is_empty() {
            let b64 = base64_encode(&bytes);
            result.insert(att_name, format!("data:{ct};base64,{b64}"));
          }
        }
      }
    }
  }

  Ok(result)
}

fn base64_encode(data: &[u8]) -> String {
  use std::io::Write;
  let mut buf = Vec::with_capacity(data.len() * 4 / 3 + 4);
  let engine = base64_engine();
  {
    let mut encoder = base64::write::EncoderWriter::new(&mut buf, &engine);
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap();
  }
  String::from_utf8(buf).unwrap()
}

fn base64_engine() -> base64::engine::GeneralPurpose {
  base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::general_purpose::PAD,
  )
}

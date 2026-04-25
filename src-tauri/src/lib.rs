use chrono::Timelike;
use rand::Rng;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

mod on_device;
mod send_limiter;

use send_limiter::{warmup_send_scale_from_age_hours, SendLimiter, WarmupScale};

macro_rules! dev_log {
  ($($arg:tt)*) => {
    if cfg!(debug_assertions) { eprintln!($($arg)*); }
  };
}

macro_rules! err_log {
  ($($arg:tt)*) => {
    eprintln!($($arg)*)
  };
}

struct SyncLiveness {
  /// From `document.visibilityState` + tauri `focus` / `blur` proxy.
  window_visible: bool,
  /// Bumped on pointer, key, scroll, visibility.
  last_user_activity: chrono::DateTime<chrono::Utc>,
  /// Unipile `thread_id` / `chat_id` for the open thread (when any).
  open_chat_id: Option<String>,
}

impl Default for SyncLiveness {
  fn default() -> Self {
    Self {
      window_visible: true,
      last_user_activity: chrono::Utc::now(),
      open_chat_id: None,
    }
  }
}

struct AppState {
  http: reqwest::Client,
  /// Coalesces concurrent `startup_sync` invocations (heartbeat tick +
  /// network-reconnect trigger + focus-after-idle trigger can all race).
  syncing: AtomicBool,
  /// X DM providers don't emit Unipile webhooks, so X backfill was running
  /// on every 2-min `startup_sync` tick. Gate to once per process launch;
  /// webhooks (Unipile) cover subsequent updates. iMessage uses the same
  /// gate for the *initial* heavy pull in `startup_sync_inner`; ongoing
  /// macOS `chat.db` sync is handled by `spawn_imessage_watcher`.
  backfilled_x: AtomicBool,
  backfilled_imessage: AtomicBool,
  /// Ensures `start_sync_heartbeat` spawns the tokio interval task at
  /// most once across the app's lifetime, even if the frontend re-mounts.
  heartbeat_started: AtomicBool,
  /// `ensure_webhooks` once per process — not every heartbeat.
  webhooks_ensured_this_launch: AtomicBool,
  /// Avatar catch-up: full scan at most once per process.
  avatar_catchup_once_per_launch: AtomicBool,
  /// `chat_id` → (attendee `items` json, `Instant` fetched at); 24h TTL.
  chat_attendees_cache: parking_lot::Mutex<std::collections::HashMap<String, (Vec<serde_json::Value>, std::time::Instant)>>,
  /// `account_id` → pause `Utc` (HTTP 403 / `account_restricted` cool-down).
  unipile_account_paused_until: parking_lot::Mutex<std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>>,
  /// Drives "heartbeat only when the user is present" (no hidden AFK).
  sync_liveness: parking_lot::RwLock<SyncLiveness>,
  /// Cache of per-Unipile-account session creation time, populated during
  /// `startup_sync_inner`. Read from `send_message` / `send_attachment`
  /// to compute the 7-day warm-up scale.
  account_ages: parking_lot::RwLock<std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>>,
  /// Token-bucket rate limiter for outbound sends per Unipile's
  /// provider-limits guidance.
  limiter: SendLimiter,
  /// Currently signed-in user id, refreshed by every `start_sync_heartbeat`
  /// call. The heartbeat and iMessage watcher tasks run once per process,
  /// so they must re-read this each iteration to survive sign-out / user
  /// switches without writing to the wrong user's rows.
  active_user_id: parking_lot::RwLock<Option<String>>,
  /// Highest `message.ROWID` seen in `~/Library/Messages/chat.db` by the
  /// iMessage watcher. Lets us skip both the SQLite scan and the Supabase
  /// upsert when nothing has advanced, and — crucially — only emit the
  /// `imessage-synced` event when there is a *real* delta. `i64::MIN` is
  /// the unset sentinel; any valid rowid is > 0.
  imessage_last_rowid: AtomicI64,
}

/// Hourly heartbeat reconciliation, base interval.
///
/// Replaces the old 2-min JS `setInterval` — that cadence was both
/// unreliable (WKWebView throttles timers when the window is
/// backgrounded, creating the "massive batches on foreground" symptom)
/// and structurally bot-like per Unipile's own guidance ("we do not
/// recommend polling at fixed times, this pattern can easily be flagged
/// as automation"). Event triggers (network reconnect, focus after 2h
/// idle, manual pull) cover most reconciliation needs; this heartbeat
/// is the sanity net that catches silently-dropped Unipile webhooks.
const SYNC_HEARTBEAT_BASE_SECS: u64 = 3600;
const SYNC_HEARTBEAT_JITTER_PCT: u32 = 20;

/// macOS-only: poll `~/Library/Messages/chat.db` while iMessage is connected.
/// Read-only SQLite on the same machine — separate from the hourly Unipile
/// heartbeat (which intentionally avoids tight remote polling).
const IMESSAGE_POLL_BASE_SECS: u64 = 90;
const IMESSAGE_POLL_JITTER_PCT: u32 = 10;
/// Delay before the first `chat.db` poll so cold `startup_sync` can finish.
const IMESSAGE_WATCHER_STAGGER_SECS: u64 = 20;

/// Skip the per-chat message pull when the most recent message is newer
/// than this — the webhook already covered it, and the 2h self-heal
/// floor (SYNC_SELF_HEAL_HOURS) still catches silently-dropped writes.
const SYNC_CHAT_RECENT_SKIP_MINUTES: i64 = 10;

/// Inter-account / inter-chat pacing jitter ranges. Unipile's guidance
/// is explicit: "Space out all actions randomly instead of executing
/// them at regular intervals." These ranges break the rigid sweep
/// pattern that a tight `for` loop would otherwise produce.
const SYNC_INTER_ACCOUNT_DELAY_MS: std::ops::Range<u64> = 1_000..3_000;
const SYNC_INTER_CHAT_DELAY_MS: std::ops::Range<u64> = 200..600;

/// Parse Unipile's `created_at` (RFC3339-ish) on a UnipileAccount into
/// a UTC `DateTime`. Returns None on malformed/empty values — caller
/// should treat as "unknown age" (conservatively Fresh tier).
fn parse_unipile_created_at(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
  if s.is_empty() { return None; }
  chrono::DateTime::parse_from_rfc3339(s)
    .ok()
    .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// 7-day ramp: send scale from `account_ages` (missing → 30% fresh).
fn warmup_scale_for(state: &AppState, account_id: &str) -> WarmupScale {
  let connected_at = state.account_ages.read().get(account_id).copied();
  match connected_at {
    Some(dt) => {
      let age_hours = chrono::Utc::now().signed_duration_since(dt).num_hours();
      warmup_send_scale_from_age_hours(age_hours)
    }
    None => 0.3,
  }
}

const SYNC_IDLE_MAX_SECS: i64 = 10 * 60;
const QUIET_HOURS_LOCAL: std::ops::Range<u32> = 2..6;
const QUIET_HOURS_MAX_IDLE_SECS: i64 = 5 * 60;

/// Hourly `startup_sync` tick only if the app is focused and the user
/// is not AFK, with extra idle limits during local 02:00–06:00.
fn should_run_heartbeat_unipile_sweep(state: &AppState) -> bool {
  let s = state.sync_liveness.read();
  if !s.window_visible {
    return false;
  }
  let now = chrono::Utc::now();
  let idle = now
    .signed_duration_since(s.last_user_activity)
    .num_seconds();
  if idle > SYNC_IDLE_MAX_SECS {
    return false;
  }
  let h = chrono::Local::now().time().hour() as u32;
  if QUIET_HOURS_LOCAL.contains(&h) && idle > QUIET_HOURS_MAX_IDLE_SECS {
    return false;
  }
  true
}

fn unipile_account_is_paused(state: &AppState, account_id: &str) -> bool {
  if account_id.is_empty() {
    return false;
  }
  let m = state.unipile_account_paused_until.lock();
  m.get(account_id)
    .is_some_and(|t| *t > chrono::Utc::now())
}

fn record_unipile_403_cooldown(state: &AppState, account_id: &str) {
  if account_id.is_empty() {
    return;
  }
  err_log!("[unipile] 403 on account {account_id} — pausing remote actions 6h");
  let until = chrono::Utc::now() + chrono::Duration::hours(6);
  let mut m = state.unipile_account_paused_until.lock();
  m.insert(account_id.to_string(), until);
}

/// Sleep for `base` seconds ± `jitter_pct` percent — used by the
/// hourly heartbeat to avoid a fixed phase alignment across app
/// launches.
async fn jittered_sleep(base_secs: u64, jitter_pct: u32) {
  let jitter = (base_secs as f64) * (jitter_pct as f64) / 100.0;
  let low = (base_secs as f64 - jitter).max(1.0);
  let high = base_secs as f64 + jitter;
  let pick = rand::thread_rng().gen_range(low..=high);
  tokio::time::sleep(Duration::from_secs_f64(pick)).await;
}

/// Synthesize a human-like `typing_duration` for Unipile's send API
/// (seconds) based on message length. Bot-detection research
/// specifically calls out consistent receive→typing→send intervals as
/// a fingerprint — firing a send with no typing delay is a strong
/// tell. Roughly 40 WPM (~50ms/char) with an initial-think jitter
/// (400–1200ms) and ±25% per-char variance, clamped so trivial
/// one-word replies don't block and essays don't stall for a minute.
fn humanized_typing_duration_seconds(text: &str) -> f64 {
  let mut rng = rand::thread_rng();
  let per_char = rng.gen_range(0.040..0.060);
  let initial = rng.gen_range(0.4..1.2);
  let raw = (text.chars().count() as f64) * per_char + initial;
  raw.clamp(0.5, 8.0)
}

/// Hours of overlap between the per-chat sync cursor (`MAX(sent_at)` in DB)
/// and the Unipile `?after=` filter. Any message written within this window
/// is re-fetched on the next `startup_sync`, so a silently-dropped upsert
/// self-heals without requiring manual intervention. Matches Unipile's own
/// guidance: "fetch a larger period than your cron delay".
const SYNC_SELF_HEAL_HOURS: i64 = 2;

/// Max Unipile `/messages` pages for a one-time full history pull per chat
/// (`chat_sync_state.backfilled_at` not yet set). `fetch_paginated` stops as
/// soon as the API omits `cursor`; this is only a safety ceiling.
const HISTORY_FETCH_MAX_PAGES: usize = 1000;

/// Supabase / PostgREST transient-failure retry budget.
///
/// Matches supabase-js v2.102.0's built-in behaviour: "up to 3 attempts with
/// exponential backoff with jitter." See
/// https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js
///
/// 5 attempts (vs. supabase-js's default of 3) because our typical failure
/// window is a laptop waking from sleep / flaking Wi-Fi reconnect — those
/// take 5–10s to stabilise, longer than 3 attempts × 1.75s = 5.25s gives us.
const SB_MAX_ATTEMPTS: u32 = 5;
const SB_BASE_BACKOFF_MS: u64 = 250;

/// HTTP status codes Supabase documents as transient / worth retrying on
/// idempotent requests. 408 (Request Timeout), 502 (Bad Gateway from
/// Cloudflare), 503 (Service Unavailable — e.g. PostgREST schema-cache
/// reload), 504 (Gateway Timeout — e.g. PGRST003 pool-acquisition timeout),
/// 520 (Cloudflare "unknown origin error").
///
/// 429 is handled separately on the Unipile path via `Retry-After`.
fn is_transient_http_status(status: u16) -> bool {
  matches!(status, 408 | 502 | 503 | 504 | 520)
}

/// Classify a `reqwest::Error` as transient (safe to retry) — connect
/// failures, timeouts, and body-decode errors that typically represent
/// a dropped connection mid-response.
fn is_transient_reqwest_error(err: &reqwest::Error) -> bool {
  err.is_timeout() || err.is_connect() || err.is_body()
}

/// Exponential backoff: 250ms, 500ms, 1s, 2s, 4s (capped at 8s).
/// Total budget across 5 attempts ≈ 7.75s, which comfortably covers the
/// typical Wi-Fi reconnect / VPN reconnect / Supavisor warm-up window.
async fn sb_backoff_sleep(attempt: u32) {
  let delay = SB_BASE_BACKOFF_MS.saturating_mul(1u64 << attempt.min(5));
  tokio::time::sleep(Duration::from_millis(delay.min(8000))).await;
}

/// Bulk PostgREST upsert with transient-error retry.
///
/// Implements two documented resilience patterns:
///   1. Bulk upsert — `POST /rest/v1/<table>?on_conflict=...` with a JSON
///      array body. PostgREST's explicit guidance for PGRST003 is to
///      "reduce write requests. Do Bulk Insert (or Upsert) instead of
///      inserting rows one by one."
///   2. Transient retry — on 408/502/503/504/520 or a transient network
///      error, retry up to `SB_MAX_ATTEMPTS` times with exponential
///      backoff, matching supabase-js's built-in retry behaviour.
///
/// `prefer` is passed through to the `Prefer:` header (e.g.
/// `"resolution=ignore-duplicates"`). Empty input is a no-op.
async fn supabase_upsert_batch(
  client: &reqwest::Client,
  supabase_url: &str,
  service_key: &str,
  table: &str,
  on_conflict: &str,
  prefer: &str,
  rows: &[serde_json::Value],
  context: &str,
) -> Result<usize, String> {
  if rows.is_empty() { return Ok(0); }
  let url = format!("{supabase_url}/rest/v1/{table}?on_conflict={on_conflict}");
  let body = serde_json::Value::Array(rows.to_vec());

  let mut attempt: u32 = 0;
  loop {
    attempt += 1;
    let resp = client
      .post(&url)
      .header("apikey", service_key)
      .header("Authorization", format!("Bearer {service_key}"))
      .header("Content-Type", "application/json")
      .header("Prefer", prefer)
      .json(&body)
      .send()
      .await;

    match resp {
      Ok(r) if r.status().is_success() || r.status().as_u16() == 409 => {
        return Ok(rows.len());
      }
      Ok(r) => {
        let status = r.status().as_u16();
        if is_transient_http_status(status) && attempt < SB_MAX_ATTEMPTS {
          err_log!("[{context}] transient {status} on upsert, retry {attempt}/{SB_MAX_ATTEMPTS}");
          sb_backoff_sleep(attempt - 1).await;
          continue;
        }
        let body_txt = r.text().await.unwrap_or_default();
        return Err(format!("[{context}] upsert failed ({status}) after {attempt}/{SB_MAX_ATTEMPTS}: {body_txt}"));
      }
      Err(e) => {
        if is_transient_reqwest_error(&e) && attempt < SB_MAX_ATTEMPTS {
          err_log!("[{context}] transient network error on upsert, retry {attempt}/{SB_MAX_ATTEMPTS}: {e}");
          sb_backoff_sleep(attempt - 1).await;
          continue;
        }
        return Err(format!("[{context}] upsert error after {attempt}/{SB_MAX_ATTEMPTS}: {e}"));
      }
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  load_root_env();

  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_zustand::init())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .setup(|app| {
      let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(5)
        .build()
        .expect("failed to build HTTP client");
      app.manage(AppState {
        http: client,
        syncing: AtomicBool::new(false),
        backfilled_x: AtomicBool::new(false),
        backfilled_imessage: AtomicBool::new(false),
        heartbeat_started: AtomicBool::new(false),
        webhooks_ensured_this_launch: AtomicBool::new(false),
        avatar_catchup_once_per_launch: AtomicBool::new(false),
        chat_attendees_cache: parking_lot::Mutex::new(std::collections::HashMap::new()),
        unipile_account_paused_until: parking_lot::Mutex::new(std::collections::HashMap::new()),
        sync_liveness: parking_lot::RwLock::new(SyncLiveness::default()),
        account_ages: parking_lot::RwLock::new(std::collections::HashMap::new()),
        limiter: SendLimiter::new(),
        active_user_id: parking_lot::RwLock::new(None),
        imessage_last_rowid: AtomicI64::new(i64::MIN),
      });
      app.manage(on_device::BridgeManager::new());

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
      update_sync_liveness,
      start_sync_heartbeat,
      backfill_messages,
      sync_chat,
      send_message,
      send_attachment,
      add_reaction,
      edit_message,
      fetch_attachment,
      open_attachment,
      fetch_chat_avatars,
      reconcile_chats,
      connect_x_account,
      connect_imessage,
      imessage_status,
      read_dropped_files,
      chat_action,
      email_flag_action,
      sync_email_flags,
      on_device::commands::on_device_start_login,
      on_device::commands::on_device_resume_all,
      on_device::commands::on_device_disconnect,
      on_device::commands::on_device_update_cookies
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn load_root_env() {
  let manifest_dir = env!("CARGO_MANIFEST_DIR");
  let root = Path::new(manifest_dir).join("..");
  let _ = dotenvy::from_path(root.join(".env.local"));
  let _ = dotenvy::from_path(root.join(".env"));

  // Production fallback: values baked in at compile time (from CI env).
  // In dev, .env.local is loaded above and takes priority.
  //
  // SECURITY (tracked in ARCHITECTURE.md "Known security issues"): the secrets
  // below are embedded into the shipped binary via `option_env!`. Anyone with
  // the .app bundle can recover them with `strings`. This is acceptable only
  // for single-user, signed-build deployments on trusted devices. Do not ship
  // to the public until the service-role / Unipile / Gemini / X-secret calls
  // are moved behind Supabase Edge Functions and this block is reduced to the
  // public VITE_SUPABASE_URL only.
  set_if_missing("VITE_SUPABASE_URL", option_env!("VITE_SUPABASE_URL"));
  set_if_missing("SUPABASE_SERVICE_ROLE_KEY", option_env!("SUPABASE_SERVICE_ROLE_KEY"));
  set_if_missing("UNIPILE_API_KEY", option_env!("UNIPILE_API_KEY"));
  set_if_missing("UNIPILE_API_URL", option_env!("UNIPILE_API_URL"));
  set_if_missing("UNIPILE_WEBHOOK_SECRET", option_env!("UNIPILE_WEBHOOK_SECRET"));
  set_if_missing("GEMINI_API_KEY", option_env!("GEMINI_API_KEY"));
  set_if_missing("X_API_CLIENT_ID", option_env!("X_API_CLIENT_ID"));
  set_if_missing("X_API_CLIENT_SECRET", option_env!("X_API_CLIENT_SECRET"));
}

fn set_if_missing(key: &str, compile_time: Option<&str>) {
  if std::env::var(key).is_err() {
    if let Some(val) = compile_time {
      unsafe { std::env::set_var(key, val); }
    }
  }
}

fn unipile_config() -> Result<(String, String), String> {
  let api_key =
    std::env::var("UNIPILE_API_KEY").map_err(|_| "UNIPILE_API_KEY is not set".to_string())?;
  let base = std::env::var("UNIPILE_API_URL")
    .map_err(|_| "UNIPILE_API_URL is not set".to_string())?;
  Ok((api_key, base.trim_end_matches('/').to_string()))
}

fn x_config() -> Result<(String, String), String> {
  let client_id =
    std::env::var("X_API_CLIENT_ID").map_err(|_| "X_API_CLIENT_ID is not set".to_string())?;
  let client_secret =
    std::env::var("X_API_CLIENT_SECRET").map_err(|_| "X_API_CLIENT_SECRET is not set".to_string())?;
  Ok((client_id, client_secret))
}

async fn fetch_paginated(
  client: &reqwest::Client,
  base_url: &str,
  api_key: &str,
  max_pages: usize,
  state: Option<&AppState>,
  account_id_for_403: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
  let mut all_items = Vec::new();
  let mut cursor: Option<String> = None;

  for _ in 0..max_pages {
    let url = match &cursor {
      Some(c) => format!("{base_url}&cursor={c}"),
      None => base_url.to_string(),
    };

    // Honor Unipile's rate limit: on 429 read Retry-After and try once more.
    // Unipile already paces Instagram/WhatsApp/LinkedIn upstream; our only job
    // is to back off when they ask. No arbitrary sleeps — that would duplicate
    // Unipile's own pacing and hide their signals.
    let resp = {
      let mut attempt = 0u8;
      loop {
        let r = client.get(&url).header("X-API-KEY", api_key).send().await
          .map_err(|e| format!("fetch failed: {e}"))?;
        if r.status().as_u16() != 429 || attempt >= 1 {
          break r;
        }
        let wait_s = r.headers()
          .get("retry-after")
          .and_then(|v| v.to_str().ok())
          .and_then(|s| s.parse::<u64>().ok())
          .unwrap_or(5)
          .min(60);
        err_log!("[fetch_paginated] 429 from {url} — waiting {wait_s}s");
        tokio::time::sleep(Duration::from_secs(wait_s)).await;
        attempt += 1;
      }
    };

    if !resp.status().is_success() {
      let status = resp.status();
      if status == reqwest::StatusCode::FORBIDDEN {
        if let (Some(s), Some(aid)) = (state, account_id_for_403) {
          if !aid.is_empty() { record_unipile_403_cooldown(s, aid); }
        }
      }
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

/// `true` when we have never recorded a successful full-history pull for this
/// thread (no row, or `backfilled_at` is null).
async fn chat_sync_history_pending(
  client: &reqwest::Client,
  supabase_url: &str,
  service_key: &str,
  user_id: &str,
  thread_id: &str,
) -> bool {
  let url = format!(
    "{supabase_url}/rest/v1/chat_sync_state?user_id=eq.{user_id}&thread_id=eq.{thread_id}&select=backfilled_at"
  );
  let Ok(resp) = client
    .get(&url)
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await
  else {
    return true;
  };
  if !resp.status().is_success() {
    dev_log!("[chat_sync_state] GET pending {} → {}", thread_id, resp.status());
    return true;
  }
  let Ok(rows) = resp.json::<Vec<serde_json::Value>>().await else {
    return true;
  };
  match rows.first() {
    None => true,
    Some(r) => match r.get("backfilled_at") {
      None | Some(serde_json::Value::Null) => true,
      Some(v) => v.as_str().map(|s| s.is_empty()).unwrap_or(true),
    },
  }
}

async fn chat_sync_mark_backfilled(
  client: &reqwest::Client,
  supabase_url: &str,
  service_key: &str,
  user_id: &str,
  thread_id: &str,
  channel: &str,
  unipile_account_id: &str,
) {
  let now = chrono::Utc::now().to_rfc3339();
  let body = serde_json::json!({
    "user_id": user_id,
    "thread_id": thread_id,
    "channel": channel,
    "unipile_account_id": unipile_account_id,
    "backfilled_at": &now,
    "updated_at": &now,
  });
  let url = format!("{supabase_url}/rest/v1/chat_sync_state?on_conflict=user_id,thread_id");
  match client
    .post(&url)
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .header("Prefer", "resolution=merge-duplicates,return=minimal")
    .json(&body)
    .send()
    .await
  {
    Ok(r) if r.status().is_success() => {}
    Ok(r) => dev_log!("[chat_sync_state] upsert {} → HTTP {}", thread_id, r.status()),
    Err(e) => dev_log!("[chat_sync_state] upsert {}: {e}", thread_id),
  }
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
      .post(format!("{supabase_url}/rest/v1/connected_accounts?on_conflict=user_id,provider,account_id"))
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

/// Delete a person and all associated data: Storage avatar, person row
/// (CASCADE deletes messages + identities), and log the deletion.
async fn purge_person(
  client: &reqwest::Client,
  supabase_url: &str,
  service_key: &str,
  person_id: &str,
  user_id: &str,
) {
  delete_avatar(client, supabase_url, service_key, person_id).await;

  let _ = client
    .delete(format!(
      "{supabase_url}/rest/v1/persons?id=eq.{person_id}"
    ))
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await;

  let _ = client
    .post(format!("{supabase_url}/rest/v1/deletion_log"))
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({
      "user_id": user_id,
      "action": "person_deleted",
      "target_id": person_id
    }))
    .send()
    .await;
}

#[tauri::command]
async fn disconnect_account(
  account_id: String,
  user_id: String,
  app_handle: tauri::AppHandle,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;

  // 1. Find all identities linked to this Unipile account
  let idents_resp = client
    .get(format!(
      "{supabase_url}/rest/v1/identities?unipile_account_id=eq.{account_id}&user_id=eq.{user_id}&select=id,person_id"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await
    .map_err(|e| format!("identity lookup failed: {e}"))?;

  let idents: Vec<serde_json::Value> = if idents_resp.status().is_success() {
    idents_resp.json().await.unwrap_or_default()
  } else {
    vec![]
  };

  // 2. For each identity, decide whether to purge the whole person or just the identity
  let mut purged_persons = std::collections::HashSet::new();
  for ident in &idents {
    let pid = ident.get("person_id").and_then(|v| v.as_str()).unwrap_or("");
    let iid = ident.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if pid.is_empty() || iid.is_empty() { continue; }
    if purged_persons.contains(pid) { continue; }

    let count_resp = client
      .get(format!(
        "{supabase_url}/rest/v1/identities?person_id=eq.{pid}&user_id=eq.{user_id}&select=id"
      ))
      .header("apikey", &service_key)
      .header("Authorization", format!("Bearer {service_key}"))
      .header("Prefer", "count=exact")
      .header("Range", "0-0")
      .send()
      .await;

    let total_identities = count_resp.ok()
      .and_then(|r| r.headers().get("content-range")?.to_str().ok()
        .and_then(|s| s.split('/').last()?.parse::<usize>().ok()))
      .unwrap_or(1);

    if total_identities <= 1 {
      purge_person(client, &supabase_url, &service_key, pid, &user_id).await;
      purged_persons.insert(pid.to_string());
    } else {
      let _ = client
        .delete(format!("{supabase_url}/rest/v1/identities?id=eq.{iid}"))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .send()
        .await;
    }
  }

  // 3. Delete connected_accounts row
  let _ = client
    .delete(format!(
      "{supabase_url}/rest/v1/connected_accounts?account_id=eq.{account_id}&user_id=eq.{user_id}"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await;

  // 4. Delete Unipile account (last — so earlier queries still work)
  let resp = client
    .delete(format!("{base}/api/v1/accounts/{account_id}"))
    .header("X-API-KEY", &api_key)
    .send()
    .await;

  if let Ok(r) = resp {
    if !r.status().is_success() && r.status().as_u16() != 404 {
      dev_log!("[disconnect] Unipile delete returned {}", r.status().as_u16());
    }
  }

  // 5. Emit event for frontend cache cleanup
  let _ = app_handle.emit("account-disconnected", &account_id);

  Ok(format!("Disconnected: purged {} persons", purged_persons.len()))
}

async fn ensure_webhooks(client: &reqwest::Client) -> Result<u32, String> {
  let (api_key, base) = unipile_config()?;
  let webhook_url = format!(
    "{}/functions/v1/unipile-webhook",
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set")?
  );
  let webhook_secret = std::env::var("UNIPILE_WEBHOOK_SECRET").unwrap_or_default();

  let list_resp = client
    .get(format!("{base}/api/v1/webhooks?limit=250"))
    .header("X-API-KEY", &api_key)
    .send().await
    .map_err(|e| format!("webhook list: {e}"))?;

  let existing: Vec<serde_json::Value> = if list_resp.status().is_success() {
    let body: serde_json::Value = list_resp.json().await.unwrap_or_default();
    body.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default()
  } else {
    Vec::new()
  };

  let registered_sources: std::collections::HashSet<String> = existing.iter()
    .filter(|w| {
      w.get("request_url").and_then(|v| v.as_str()).unwrap_or("") == webhook_url
    })
    .filter_map(|w| w.get("source").and_then(|v| v.as_str()).map(String::from))
    .collect();

  let headers = if webhook_secret.is_empty() {
    serde_json::json!([{"key": "Content-Type", "value": "application/json"}])
  } else {
    serde_json::json!([{"key": "x-webhook-secret", "value": webhook_secret}])
  };

  let sources = vec![
    ("messaging", serde_json::json!(["message_received", "message_reaction", "message_read", "message_edited", "message_deleted", "message_delivered"])),
    ("email", serde_json::json!(["mail_received", "mail_sent", "mail_moved"])),
    ("account_status", serde_json::json!(["creation_success", "creation_fail", "reconnected", "error", "credentials"])),
  ];

  let mut created = 0u32;
  for (source, events) in &sources {
    if registered_sources.contains(*source) { continue; }
    let body = serde_json::json!({
      "request_url": webhook_url,
      "source": source,
      "events": events,
      "name": format!("Convolios {}", source),
      "headers": headers,
    });
    let resp = client.post(format!("{base}/api/v1/webhooks"))
      .header("X-API-KEY", &api_key)
      .header("Content-Type", "application/json")
      .json(&body)
      .send().await;
    if let Ok(r) = resp { if r.status().is_success() { created += 1; } }
  }
  Ok(created)
}

/// Drives heartbeat gating: window visibility, user-activity bump, and which
/// Unipile thread is open (empty / absent = no thread hint).
#[tauri::command]
async fn update_sync_liveness(
  window_visible: bool,
  open_chat_id: Option<String>,
  bump_activity: bool,
  state: State<'_, AppState>,
) -> Result<(), String> {
  let mut s = state.sync_liveness.write();
  s.window_visible = window_visible;
  s.open_chat_id = open_chat_id.filter(|id| !id.is_empty());
  if bump_activity {
    s.last_user_activity = chrono::Utc::now();
  }
  Ok(())
}

/// `open_chat_id`: Unipile `chat_id` / `thread_id` for the active thread (if any).
/// `mode` `"light"` = accounts + at most this chat (or none). `"full"` = 72h per-account
/// sweep (Re-sync in settings).
#[tauri::command]
async fn startup_sync(
  user_id: String,
  mode: Option<String>,
  open_chat_id: Option<String>,
  state: State<'_, AppState>,
  app_handle: tauri::AppHandle,
) -> Result<String, String> {
  if state.syncing.swap(true, Ordering::SeqCst) {
    return Ok("Already syncing".to_string());
  }
  let full_sweep = mode.as_deref() == Some("full");
  let result = startup_sync_inner(
    &user_id, state.inner(), &app_handle, full_sweep, open_chat_id, false,
  ).await;
  state.syncing.store(false, Ordering::SeqCst);
  let _ = app_handle.emit("sync-status", serde_json::json!({ "phase": "idle" }));
  result
}

/// Spawn the background reconciliation heartbeat exactly once per
/// app lifetime. Replaces the JS `setInterval` loop in `App.tsx` — the
/// WKWebView throttles/suspends JS timers when the window is
/// backgrounded on macOS (tauri-apps/wry#1246), which produced the
/// "massive batches on foreground" symptom users observed.
///
/// The frontend calls this once from the `Authenticated` mount effect,
/// passing the signed-in user id. Event-driven triggers (network
/// reconnect, focus-after-idle, manual pull) cover most reconciliation
/// work; this heartbeat is the sanity net that catches silently-dropped
/// Unipile webhooks.
#[tauri::command]
async fn start_sync_heartbeat(
  user_id: String,
  state: State<'_, AppState>,
  app_handle: tauri::AppHandle,
) -> Result<(), String> {
  // Refresh the active user on every call so the already-running background
  // tasks (heartbeat + iMessage watcher) pick up sign-outs and user switches
  // without requiring an app restart — both tasks are set-once-per-process.
  *state.active_user_id.write() = Some(user_id);

  if state.heartbeat_started.swap(true, Ordering::SeqCst) {
    return Ok(());
  }
  dev_log!("[sync_heartbeat] spawning — base {SYNC_HEARTBEAT_BASE_SECS}s ±{SYNC_HEARTBEAT_JITTER_PCT}%");
  let app = app_handle.clone();
  tauri::async_runtime::spawn(async move {
    loop {
      jittered_sleep(SYNC_HEARTBEAT_BASE_SECS, SYNC_HEARTBEAT_JITTER_PCT).await;
      let state: State<'_, AppState> = app.state();
      // Scope the read guard so it doesn't cross an await and break `Send`.
      let active_uid = state.active_user_id.read().clone();
      let uid = match active_uid {
        Some(u) => u,
        None => {
          dev_log!("[sync_heartbeat] skipped — no active user");
          continue;
        }
      };
      if state.syncing.swap(true, Ordering::SeqCst) {
        dev_log!("[sync_heartbeat] skipped — sync already in progress");
        continue;
      }
      if !should_run_heartbeat_unipile_sweep(state.inner()) {
        state.syncing.store(false, Ordering::SeqCst);
        dev_log!("[sync_heartbeat] skipped — liveness (hidden / AFK / quiet hours)");
        continue;
      }
      let open = state.inner().sync_liveness.read().open_chat_id.clone();
      dev_log!("[sync_heartbeat] tick (light, open={:?})", open);
      let _ = startup_sync_inner(
        &uid, state.inner(), &app, false, open, true,
      ).await;
      state.syncing.store(false, Ordering::SeqCst);
      let _ = app.emit("sync-status", serde_json::json!({ "phase": "idle" }));
    }
  });
  #[cfg(target_os = "macos")]
  spawn_imessage_watcher(app_handle);
  #[cfg(not(target_os = "macos"))]
  let _ = app_handle;
  Ok(())
}

/// Background poller for new iMessages on macOS.
///
/// Why an explicit rowid watermark: `backfill_imessage` → `supabase_upsert_batch`
/// uses `Prefer: resolution=ignore-duplicates,return=minimal`, which returns
/// no body on success. `supabase_upsert_batch` therefore reports
/// `rows.len()` — the batch size, not the number of *new* rows. Emitting
/// `imessage-synced` based on that count would fire every poll cycle (~90s)
/// as long as any iMessage history exists, triggering pointless React Query
/// invalidations.
///
/// Instead we read `MAX(ROWID)` from `chat.db` (a single B-tree lookup) and
/// only run the backfill + emit the event when the rowid has advanced past
/// our stored watermark. The watermark advances only after a successful
/// upsert, so transient failures are retried on the next tick.
#[cfg(target_os = "macos")]
fn spawn_imessage_watcher(app: tauri::AppHandle) {
  tauri::async_runtime::spawn(async move {
    // Stagger after cold `startup_sync` so we do not contend on `chat.db`
    // during the first gated `backfill_imessage` pass.
    tokio::time::sleep(Duration::from_secs(IMESSAGE_WATCHER_STAGGER_SECS)).await;
    loop {
      let state: State<'_, AppState> = app.state();
      // Scope the read guard so it doesn't cross an await and break `Send`.
      let active_uid = state.active_user_id.read().clone();
      let user_id = match active_uid {
        Some(u) => u,
        None => {
          jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
          continue;
        }
      };
      if state.syncing.load(Ordering::SeqCst) {
        jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
        continue;
      }
      let db_path = match imessage_db_path() {
        Ok(p) => p,
        Err(_) => {
          jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
          continue;
        }
      };
      let current_rowid = match imessage_max_rowid(&db_path) {
        Ok(v) => v,
        Err(e) => {
          dev_log!("[imessage_watch] rowid probe: {e}");
          jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
          continue;
        }
      };
      let prev_rowid = state.imessage_last_rowid.load(Ordering::SeqCst);
      if current_rowid <= prev_rowid {
        jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
        continue;
      }
      let supabase_url = match std::env::var("VITE_SUPABASE_URL") {
        Ok(v) => v,
        Err(_) => {
          err_log!("[imessage_watch] VITE_SUPABASE_URL missing — pausing watcher");
          jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
          continue;
        }
      };
      let service_key = match std::env::var("SUPABASE_SERVICE_ROLE_KEY") {
        Ok(v) => v,
        Err(_) => {
          err_log!("[imessage_watch] SUPABASE_SERVICE_ROLE_KEY missing — pausing watcher");
          jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
          continue;
        }
      };
      match backfill_imessage(&state.inner().http, &user_id, &supabase_url, &service_key).await {
        Ok((m, _)) => {
          state.imessage_last_rowid.store(current_rowid, Ordering::SeqCst);
          // First poll after launch just seeds the watermark against the
          // `chat.db` state that `startup_sync_inner` has already pushed to
          // Supabase, so suppress the emit to avoid a redundant UI refresh.
          let was_seeding = prev_rowid == i64::MIN;
          if !was_seeding {
            dev_log!("[imessage_watch] rowid {prev_rowid}→{current_rowid}, upserted {m} row(s)");
            let _ = app.emit("imessage-synced", serde_json::json!({}));
          } else {
            dev_log!("[imessage_watch] seeded watermark at rowid {current_rowid}");
          }
        }
        Err(e) => dev_log!("[imessage_watch] {e}"),
      }
      jittered_sleep(IMESSAGE_POLL_BASE_SECS, IMESSAGE_POLL_JITTER_PCT).await;
    }
  });
}

async fn startup_sync_inner(
  user_id: &str,
  state: &AppState,
  app: &tauri::AppHandle,
  full_sweep: bool,
  open_chat_id: Option<String>,
  from_heartbeat: bool,
) -> Result<String, String> {
  if from_heartbeat && !should_run_heartbeat_unipile_sweep(state) {
    return Ok("skipped: heartbeat liveness".to_string());
  }
  // Simple emit for phase transitions without per-account progress.
  let emit = |phase: &str, detail: &str| {
    let _ = app.emit("sync-status", serde_json::json!({ "phase": phase, "detail": detail }));
  };
  // Enriched emit with account progress — surfaced in the sync banner as
  // "Syncing WhatsApp (3 of 9)". Channel is the frontend `Channel` enum value
  // so the UI can look up the localised label itself.
  let emit_account = |phase: &str, detail: &str, idx: usize, total: usize, channel: &str| {
    let _ = app.emit("sync-status", serde_json::json!({
      "phase": phase,
      "detail": detail,
      "account": { "idx": idx, "total": total, "channel": channel },
    }));
  };
  // Same as emit_account, but adds per-chat progress within the account
  // loop so the banner never looks frozen when a single account has many
  // chats (e.g. LinkedIn/Telegram w/ 100+ active threads in the 72h window).
  // Rendered as "Syncing LinkedIn (3/9) · 17/52 chats" on the frontend.
  let emit_account_chat = |phase: &str, detail: &str, acc_idx: usize, acc_total: usize, channel: &str, chat_idx: usize, chat_total: usize| {
    let _ = app.emit("sync-status", serde_json::json!({
      "phase": phase,
      "detail": detail,
      "account": { "idx": acc_idx, "total": acc_total, "channel": channel },
      "chat": { "idx": chat_idx, "total": chat_total },
    }));
  };
  emit("syncing", "Fetching accounts...");

  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let client = &state.http;
  let accounts = match fetch_accounts_inner(client).await {
    Ok(a) => a,
    Err(e) => { dev_log!("[startup_sync] account fetch failed: {e}"); return Err(format!("Account fetch failed: {e}")); }
  };

  if state.webhooks_ensured_this_launch
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_ok()
  {
    emit("syncing", "Ensuring webhooks…");
    match ensure_webhooks(client).await {
      Ok(n) if n > 0 => dev_log!("[startup_sync] registered {n} missing webhooks"),
      Err(e) => dev_log!("[startup_sync] webhook check failed: {e}"),
      _ => {}
    }
  }

  emit("syncing", &format!("Found {} accounts, checking recent activity...", accounts.len()));

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
    // Single-row bulk upsert so transient 5xx / network errors get the
    // same exponential-backoff retry treatment as message writes. Without
    // this, a transient Supabase pool stall aborts the whole account and
    // `last_synced_at` never advances on that launch.
    match supabase_upsert_batch(
      client,
      &supabase_url,
      &service_key,
      "connected_accounts",
      "user_id,provider,account_id",
      "resolution=merge-duplicates",
      std::slice::from_ref(&body),
      &format!("startup_sync account {} ({})", acc.name, acc.id),
    ).await {
      Ok(n) => synced += n as u32,
      Err(e) => err_log!("{e}"),
    }
  }

  let cutoff = (chrono::Utc::now() - chrono::Duration::hours(72))
    .format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
  let mut msgs_synced = 0u32;

  // X has no webhook path here, so keep it on the hourly/focused heartbeat.
  // The first launch also runs it immediately; later heartbeat ticks rely on
  // the same self-heal cursor used inside `backfill_x_dms`.
  let should_sync_x = from_heartbeat
    || full_sweep
    || state.backfilled_x.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok();
  if should_sync_x {
    emit("syncing", "Syncing X DMs...");
    match backfill_x_dms(client, user_id, &supabase_url, &service_key).await {
      Ok((m, c)) if m > 0 => dev_log!("[startup_sync] X: {m} msgs from {c} chats"),
      Err(e) => dev_log!("[startup_sync] X DM error: {e}"),
      _ => {}
    }
  }

  if state.backfilled_imessage.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
    emit("syncing", "Syncing iMessage...");
    match backfill_imessage(client, user_id, &supabase_url, &service_key).await {
      Ok((m, c)) if m > 0 => dev_log!("[startup_sync] iMessage: {m} msgs from {c} chats"),
      Err(e) => dev_log!("[startup_sync] iMessage error: {e}"),
      _ => {}
    }
  }

  // Populate the `account_ages` cache used by `send_message` /
  // `send_attachment` to pick a warm-up tier without a Supabase
  // round-trip. Parsing every tick is cheap (O(N) with N ~= number
  // of connected accounts).
  {
    let mut ages = state.account_ages.write();
    ages.clear();
    for acc in &keep {
      if let Some(dt) = parse_unipile_created_at(&acc.created_at) {
        ages.insert(acc.id.clone(), dt);
      }
    }
  }

  // Fresh IG accounts (0–24h): skip Unipile pulls entirely. Unipile
  // explicitly recommends starting with low activity and ramping up,
  // and the connection-time "automated behavior" warning is more likely
  // to escalate into a restriction if we hammer reads on a session
  // that just came online. Webhooks still deliver in real time during
  // this window.
  let active_accounts: Vec<&UnipileAccount> = keep.iter()
    .filter(|a| a.status == "OK" || a.status == "RUNNING")
    .filter(|a| {
      let channel = channel_from_type(&a.account_type);
      if channel != "instagram" {
        return true;
      }
      match parse_unipile_created_at(&a.created_at) {
        Some(dt) => {
          let age_hours = chrono::Utc::now().signed_duration_since(dt).num_hours();
          if age_hours < 24 {
            dev_log!("[startup_sync] fresh-account cooldown: skipping IG {} ({}h old)", a.id, age_hours);
            false
          } else {
            true
          }
        }
        None => true,
      }
    })
    .cloned()
    .collect();

  let open_req = open_chat_id.clone();
  let (single_chat_json, single_acc_id) = if full_sweep {
    (None, None)
  } else if let Some(ref cid) = open_req {
    if cid.is_empty() {
      (None, None)
    } else {
      let u = format!("{base}/api/v1/chats/{cid}");
      match client.get(&u).header("X-API-KEY", &api_key).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::FORBIDDEN => {
          err_log!("[startup_sync] single-chat GET {cid}: 403 (account may be restricted)");
          (None, None)
        }
        Ok(r) if r.status().is_success() => {
          let j: serde_json::Value = r.json().await.unwrap_or(serde_json::Value::Null);
          let a = j.get("account_id").and_then(|v| v.as_str()).map(String::from);
          (Some(j), a)
        }
        Ok(r) => {
          let status = r.status();
          let body = r.text().await.unwrap_or_default();
          err_log!("[startup_sync] single-chat GET {cid} failed: HTTP {status}: {body}");
          (None, None)
        }
        Err(e) => {
          err_log!("[startup_sync] single-chat GET {cid} error: {e}");
          (None, None)
        }
      }
    }
  } else {
    (None, None)
  };

  let do_unipile_chats = full_sweep || (single_chat_json.is_some() && single_acc_id.is_some());

  if do_unipile_chats {
  for (acc_idx, acc) in active_accounts.iter().enumerate() {
    if unipile_account_is_paused(state, &acc.id) { continue; }
    if !full_sweep {
      if let Some(w) = &single_acc_id {
        if w != &acc.id { continue; }
      }
    }

    // Inter-account jitter. Unipile's explicit guidance: "Space out all
    // actions randomly instead of executing them at regular intervals."
    // First iteration (acc_idx == 0) doesn't need to wait.
    if acc_idx > 0 {
      let ms = rand::thread_rng().gen_range(SYNC_INTER_ACCOUNT_DELAY_MS);
      tokio::time::sleep(Duration::from_millis(ms)).await;
    }

    let channel = channel_from_type(&acc.account_type);
    let acc_disp_idx = if full_sweep { acc_idx + 1 } else { 1 };
    let acc_disp_total = if full_sweep { active_accounts.len() } else { 1 };
    emit_account(
      "syncing",
      &format!("Checking {}", acc.name),
      acc_disp_idx,
      acc_disp_total,
      channel,
    );

    let chats: Vec<serde_json::Value> = if full_sweep {
      let chats_url = format!("{base}/api/v1/chats?account_id={}&limit=50&after={cutoff}", acc.id);
      match fetch_paginated(client, &chats_url, &api_key, 10, Some(state), Some(&acc.id)).await {
        Ok(c) => c,
        Err(e) => {
          err_log!("[startup_sync] chats fetch failed for {} ({}): {e}", acc.name, acc.id);
          continue;
        }
      }
    } else {
      match single_chat_json.as_ref() {
        Some(sj) => vec![sj.clone()],
        None => continue,
      }
    };

    let chats_total = chats.len();
    for (chat_idx, chat) in chats.iter().enumerate() {
      let chat_id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
      if chat_id.is_empty() { continue; }

      // Inter-chat jitter. Short by design (hundreds of ms) so a sweep
      // of 50 chats still completes in under a minute, but enough to
      // break the rigid `for`-loop cadence that a detector could pick
      // out. First chat in the list skips the wait.
      if chat_idx > 0 {
        let ms = rand::thread_rng().gen_range(SYNC_INTER_CHAT_DELAY_MS);
        tokio::time::sleep(Duration::from_millis(ms)).await;
      }

      // Per-chat progress — fires at the start of every chat so a long
      // account (LinkedIn/Telegram w/ 100+ threads) shows visible motion
      // instead of parking on "Syncing X (N of M)" for minutes.
      emit_account_chat(
        "syncing",
        &format!("Checking {}", acc.name),
        acc_disp_idx,
        acc_disp_total,
        channel,
        chat_idx + 1,
        chats_total,
      );

      // Per-chat sync cursor with a 2h self-heal floor.
      //
      // Strategy (matches Unipile's own guidance for cron-based sync):
      // "fetch a larger period than your cron delay to account for any
      // potential disconnects or errors" — plus dedupe by message_id.
      //
      //   cursor = MIN(MAX(sent_at in DB), now - 2h)
      //
      // - Common case: cursor is "2h ago" → fast fetch of recent deltas only.
      // - If a prior write failed silently (42P10, network drop, etc.), the
      //   next startup within 2h re-fetches that window and fills the gap.
      //   Dedup is guaranteed by the (user_id, external_id) unique index +
      //   resolution=ignore-duplicates on the upsert below.
      // - Webhooks advance MAX(sent_at) but NEVER advance the sync cursor
      //   past "now - 2h", so a webhook-after-failed-sync cannot orphan
      //   messages like the old cursor did.
      // - Gaps older than 2h require a manual Pull (72h chat-list window).
      let last_sync_resp = client
        .get(format!(
          "{supabase_url}/rest/v1/messages?user_id=eq.{user_id}&thread_id=eq.{chat_id}&select=sent_at&order=sent_at.desc&limit=1"
        ))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .send().await;

      let max_sent_at: Option<chrono::DateTime<chrono::Utc>> = match last_sync_resp {
        Ok(r) if r.status().is_success() => {
          let rows: Vec<serde_json::Value> = r.json().await.unwrap_or_default();
          rows.first()
            .and_then(|r| r.get("sent_at").and_then(|v| v.as_str()))
            .and_then(|ts| chrono::DateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f%:z").ok()
              .or_else(|| chrono::DateTime::parse_from_rfc3339(ts).ok()))
            .map(|dt| dt.with_timezone(&chrono::Utc))
        }
        _ => None,
      };
      let chat_exists_in_db = max_sent_at.is_some();

      let self_heal_floor = chrono::Utc::now() - chrono::Duration::hours(SYNC_SELF_HEAL_HOURS);
      let msg_cutoff: Option<String> = max_sent_at.map(|t| {
        std::cmp::min(t, self_heal_floor)
          .format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
      });

      let needs_initial_history_backfill = chat_sync_history_pending(
        client,
        &supabase_url,
        &service_key,
        user_id,
        chat_id,
      )
      .await;

      let is_group = chat.get("type").and_then(|v| v.as_u64()).unwrap_or(0) >= 1;
      let msg_type = if is_group { "group" } else { "dm" };
      let chat_name = chat.get("name").and_then(|v| v.as_str()).unwrap_or("");

      // For DMs, chat_attendees — used for identity + avatar. Cache 24h per
      // chat to avoid a GET on every light sync / heartbeat tick.
      const ATT_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);
      let dm_attendees: Vec<serde_json::Value> = if !is_group {
        let now = std::time::Instant::now();
        let hit = {
          let c = state.chat_attendees_cache.lock();
          c.get(chat_id)
            .filter(|(_, t)| now.duration_since(*t) < ATT_TTL)
            .map(|(v, _)| v.clone())
        };
        if let Some(v) = hit {
          v
        } else {
          let att_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
          let fetched = match client.get(&att_url).header("X-API-KEY", &api_key).send().await {
            Ok(r) if r.status().is_success() => {
              let body: serde_json::Value = r.json().await.unwrap_or_default();
              body.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default()
            }
            _ => Vec::new(),
          };
          state.chat_attendees_cache.lock().insert(chat_id.to_string(), (fetched.clone(), now));
          fetched
        }
      } else {
        Vec::new()
      };

      let other_att = dm_attendees.iter().find(|a| {
        let is_self = a.get("is_self")
          .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
          .unwrap_or(false);
        !is_self
      });

      let sender_handle;
      let display_name;
      if is_group {
        display_name = if chat_name.is_empty() { "Group Chat".to_string() } else { chat_name.to_string() };
        sender_handle = normalize_handle(
          chat.get("provider_id").and_then(|v| v.as_str()).unwrap_or(chat_id),
          channel
        );
      } else {

        let resolved;
        let resolved_name;

        if let Some(other) = other_att {
          // Use the non-self attendee's identifier as the handle
          let other_handle = other.get("public_identifier")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| other.get("identifier")
              .and_then(|v| v.as_str())
              .filter(|s| !s.is_empty()))
            .or_else(|| other.get("provider_id")
              .and_then(|v| v.as_str())
              .filter(|s| !s.is_empty()))
            .unwrap_or(chat_id);
          resolved = normalize_handle(other_handle, channel);

          let other_name = other.get("display_name")
            .or_else(|| other.get("name"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("");
          resolved_name = if !other_name.is_empty() {
            other_name.to_string()
          } else if !chat_name.is_empty() {
            chat_name.to_string()
          } else {
            resolved.clone()
          };
        } else {
          // Fallback: chat_attendees unavailable, use chat object fields
          let sender_handle_raw = chat.get("attendee_public_identifier")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && !s.contains("@lid"))
            .or_else(|| chat.get("attendee_provider_id")
              .and_then(|v| v.as_str())
              .filter(|s| !s.is_empty() && !s.contains("@lid")))
            .or_else(|| chat.get("provider_id")
              .and_then(|v| v.as_str())
              .filter(|s| !s.is_empty()))
            .unwrap_or(chat_id);
          resolved = normalize_handle(sender_handle_raw, channel);
          resolved_name = if !chat_name.is_empty() { chat_name.to_string() } else { resolved.clone() };
        }

        sender_handle = resolved;
        display_name = resolved_name;
      }

      // For new conversations, pre-fetch messages to determine direction before creating person.
      // Reused later to avoid a redundant API call.
      let pre_fetched_msgs: Option<Vec<serde_json::Value>> = if !chat_exists_in_db && !is_group {
        let msgs_url = format!("{base}/api/v1/chats/{chat_id}/messages?limit=50");
        fetch_paginated(client, &msgs_url, &api_key, 3, Some(state), Some(&acc.id)).await.ok()
      } else {
        None
      };

      let direction_param = if is_group {
        Some("outbound")
      } else if !chat_exists_in_db {
        let has_outbound = pre_fetched_msgs.as_ref().map_or(false, |msgs| {
          msgs.iter().any(|m| m.get("is_sender").map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1)).unwrap_or(false))
        });
        Some(if has_outbound { "outbound" } else { "inbound" })
      } else {
        None
      };

      let mut rpc_body = serde_json::json!({
        "p_user_id": user_id, "p_channel": channel,
        "p_handle": sender_handle, "p_display_name": display_name,
        "p_unipile_account_id": acc.id
      });
      if let Some(dir) = direction_param {
        rpc_body.as_object_mut().unwrap().insert("p_direction".to_string(), serde_json::Value::String(dir.to_string()));
      }

      let person_resp = client
        .post(format!("{supabase_url}/rest/v1/rpc/backfill_find_or_create_person"))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Content-Type", "application/json")
        .json(&rpc_body)
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

      // Reconcile: if this thread already has messages under a different person,
      // reassign them. Happens when WhatsApp returns an internal LID on first sync
      // and the real phone number on a subsequent sync.
      if !is_group {
        let thread_check_url = format!(
          "{supabase_url}/rest/v1/messages?user_id=eq.{user_id}&thread_id=eq.{chat_id}&select=person_id&limit=1"
        );
        if let Ok(r) = client.get(&thread_check_url)
          .header("apikey", &service_key)
          .header("Authorization", format!("Bearer {service_key}"))
          .send().await
        {
          if let Ok(rows) = r.json::<Vec<serde_json::Value>>().await {
            if let Some(existing_pid) = rows.first().and_then(|r| r.get("person_id").and_then(|v| v.as_str())) {
              if existing_pid != person_id {
                dev_log!("[startup_sync] thread {chat_id}: reassigning from {existing_pid} → {person_id}");
                let _ = client.post(format!("{supabase_url}/rest/v1/rpc/reassign_thread_person"))
                  .header("apikey", &service_key)
                  .header("Authorization", format!("Bearer {service_key}"))
                  .header("Content-Type", "application/json")
                  .json(&serde_json::json!({
                    "p_user_id": user_id,
                    "p_thread_id": chat_id,
                    "p_from_person_id": existing_pid,
                    "p_to_person_id": person_id,
                    "p_to_identity_id": identity_id,
                  }))
                  .send().await;
              }
            }
          }
        }
      }

      // For DMs, upload avatar if person has no avatar or avatar is stale
      if !is_group {
        let check_url = format!(
          "{supabase_url}/rest/v1/persons?id=eq.{person_id}&select=avatar_url,avatar_stale"
        );
        let needs_avatar = match client.get(&check_url)
          .header("apikey", &service_key)
          .header("Authorization", format!("Bearer {service_key}"))
          .header("Accept", "application/vnd.pgrst.object+json")
          .send().await
        {
          Ok(r) if r.status().is_success() => {
            let p: serde_json::Value = r.json().await.unwrap_or_default();
            let has_url = p.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("").len() > 10;
            let stale = p.get("avatar_stale").and_then(|v| v.as_bool()).unwrap_or(true);
            !has_url || stale
          }
          _ => true,
        };

        if needs_avatar {
          // Reuse dm_attendees already fetched for identity resolution
          for att in &dm_attendees {
            let is_self = att.get("is_self")
              .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
              .unwrap_or(false);
            if is_self { continue; }
            let att_id = att.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if att_id.is_empty() { continue; }
            let pic_url = att.get("picture_url").and_then(|v| v.as_str());
            upload_avatar(
              client, &api_key, &base, &supabase_url, &service_key,
              &person_id, att_id, pic_url,
            ).await;
            break;
          }
        }
      }

      let attendee_map: std::collections::HashMap<String, String> = if is_group {
        let att_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
        match client.get(&att_url).header("X-API-KEY", &api_key).send().await {
          Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            body.get("items").and_then(|v| v.as_array()).map(|arr| {
              arr.iter().filter_map(|a| {
                let id = a.get("id").and_then(|v| v.as_str())?;
                let name = a.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                  .or_else(|| a.get("public_identifier").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                  .or_else(|| a.get("provider_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))?;
                Some((id.to_string(), name.to_string()))
              }).collect()
            }).unwrap_or_default()
          }
          _ => std::collections::HashMap::new(),
        }
      } else {
        std::collections::HashMap::new()
      };

      // Skip the message pull when the last message we have is newer
      // than SYNC_CHAT_RECENT_SKIP_MINUTES. The webhook already covered
      // any newer messages; the 2h self-heal floor (SYNC_SELF_HEAL_HOURS)
      // still catches silently-dropped webhook writes on the next tick
      // that is NOT short-circuited. Saves a Unipile call per quiet chat
      // on every heartbeat sweep.
      let skip_threshold = chrono::Utc::now() - chrono::Duration::minutes(SYNC_CHAT_RECENT_SKIP_MINUTES);
      let skip_message_pull = !needs_initial_history_backfill
        && max_sent_at.map(|t| t > skip_threshold).unwrap_or(false);

      // Inbound pin sync: only when we are not short-circuiting a recent
      // thread (avoids an RPC on every hourly sweep for idle chats).
      if channel == "whatsapp" && !skip_message_pull {
        let is_pinned = chat.get("pinned")
          .and_then(|v| v.as_bool())
          .or_else(|| chat.get("is_pinned").and_then(|v| v.as_bool()))
          .unwrap_or(false);
        match client.post(format!("{supabase_url}/rest/v1/rpc/sync_person_pin"))
          .header("apikey", &service_key)
          .header("Authorization", format!("Bearer {service_key}"))
          .header("Content-Type", "application/json")
          .json(&serde_json::json!({
            "p_user_id": user_id,
            "p_person_id": person_id,
            "p_pinned": is_pinned,
          }))
          .send().await
        {
          Ok(r) if !r.status().is_success() => {
            dev_log!("[startup_sync] sync_person_pin failed: {}", r.status());
          }
          Err(e) => {
            dev_log!("[startup_sync] sync_person_pin error: {e}");
          }
          _ => {}
        }
      }

      let messages = if needs_initial_history_backfill {
        let msgs_url = format!("{base}/api/v1/chats/{chat_id}/messages?limit=100");
        match fetch_paginated(
          client,
          &msgs_url,
          &api_key,
          HISTORY_FETCH_MAX_PAGES,
          Some(state),
          Some(&acc.id),
        )
        .await
        {
          Ok(m) => {
            if !m.is_empty() {
              dev_log!("[startup_sync] history backfill {} msgs for {chat_id}", m.len());
            }
            m
          }
          Err(e) => {
            dev_log!("[startup_sync] history backfill FAIL {chat_id}: {e}");
            continue;
          }
        }
      } else if let Some(m) = pre_fetched_msgs {
        if !m.is_empty() { dev_log!("[startup_sync] {} msgs for {chat_id} (pre-fetched)", m.len()); }
        m
      } else if skip_message_pull {
        Vec::new()
      } else {
        let msgs_url = match &msg_cutoff {
          Some(ts) => format!("{base}/api/v1/chats/{chat_id}/messages?limit=50&after={ts}"),
          None => format!("{base}/api/v1/chats/{chat_id}/messages?limit=50"),
        };
        match fetch_paginated(client, &msgs_url, &api_key, 3, Some(state), Some(&acc.id)).await {
          Ok(m) => { if !m.is_empty() { dev_log!("[startup_sync] {} msgs for {chat_id}", m.len()); } m }
          Err(e) => { dev_log!("[startup_sync] FAIL {chat_id}: {e}"); continue; }
        }
      };

      let email_sender_map: std::collections::HashMap<String, (String, String)> =
        if channel == "email" && !is_group && needs_initial_history_backfill {
          unipile_email_attendee_index(&dm_attendees)
        } else {
          std::collections::HashMap::new()
        };
      let mut email_resolved_senders: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();

      let mut rows_to_upsert: Vec<serde_json::Value> = Vec::with_capacity(messages.len());
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
        let msg_subject = msg.get("subject").and_then(|v| v.as_str());

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
            .or(Some("Unknown".to_string()))
        } else {
          None
        };

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
        let chat_folder = chat.get("folder").and_then(|v| v.as_str()).unwrap_or("");

        let (msg_person_id, msg_identity_id) = if channel == "email"
          && !is_group
          && needs_initial_history_backfill
          && !is_sender
        {
          let sender_att_id = msg
            .get("sender_attendee_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
          let from_pub = msg
            .get("sender_public_identifier")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

          let mut peer: Option<(String, String)> = None;
          if let Some(t) = email_sender_map.get(sender_att_id) {
            peer = Some((t.0.clone(), t.1.clone()));
          } else if let Some(frm) = from_pub {
            let nfrm = normalize_handle(frm, channel);
            for a in &dm_attendees {
              if let Some(rh) = unipile_attendee_handle_raw(a) {
                if normalize_handle(&rh, channel) == nfrm {
                  let name = unipile_attendee_display_name(a, &rh);
                  peer = Some((rh, name));
                  break;
                }
              }
            }
            if peer.is_none() {
              let disp = sender_name
                .clone()
                .unwrap_or_else(|| frm.to_string());
              peer = Some((frm.to_string(), disp));
            }
          }

          match &peer {
            None => (person_id.clone(), identity_id.clone()),
            Some((raw_handle, display)) => {
              let sender_h = normalize_handle(raw_handle, channel);
              if sender_h == sender_handle || sender_h.is_empty() {
                (person_id.clone(), identity_id.clone())
              } else if let Some(cached) = email_resolved_senders.get(&sender_h) {
                cached.clone()
              } else if let Some(pair) = unipile_resolve_inbound_email_identity(
                client,
                &supabase_url,
                &service_key,
                user_id,
                channel,
                &acc.id,
                &sender_h,
                display,
              )
              .await
              {
                email_resolved_senders.insert(sender_h, pair.clone());
                pair
              } else {
                (person_id.clone(), identity_id.clone())
              }
            }
          }
        } else {
          (person_id.clone(), identity_id.clone())
        };

        // PGRST102 requires identical keys across every row in a bulk
        // upsert, so `read_at` and `flagged_at` are always present. Both
        // are only meaningful on insert (ignore-duplicates) — existing
        // rows keep whatever value they already have.
        let read_at_val = if !is_sender && !chat_exists_in_db {
          serde_json::Value::String(chrono::Utc::now().to_rfc3339())
        } else {
          serde_json::Value::Null
        };

        let flagged_at_val = if channel == "email" {
          let is_starred = msg.get("role")
            .and_then(|v| v.as_str())
            .map(|r| r.contains("starred") || r.contains("flagged"))
            .unwrap_or(false)
            || msg.get("folders")
              .and_then(|v| v.as_array())
              .map(|arr| arr.iter().any(|f|
                f.as_str().map(|s| s.eq_ignore_ascii_case("STARRED") || s.eq_ignore_ascii_case("FLAGGED")).unwrap_or(false)
              ))
              .unwrap_or(false);
          if is_starred {
            serde_json::Value::String(chrono::Utc::now().to_rfc3339())
          } else {
            serde_json::Value::Null
          }
        } else {
          serde_json::Value::Null
        };

        let row = serde_json::json!({
          "user_id": user_id, "person_id": msg_person_id,
          "identity_id": if msg_identity_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(msg_identity_id.clone()) },
          "external_id": external_id, "channel": channel,
          "direction": direction, "message_type": msg_type,
          "body_text": body_text, "attachments": attachments,
          "subject": msg_subject,
          "thread_id": chat_id, "sent_at": timestamp,
          "sender_name": sender_name,
          "reactions": reactions,
          "triage": "unclassified", "unipile_account_id": acc.id,
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
          "read_at": read_at_val,
          "flagged_at": flagged_at_val,
        });

        rows_to_upsert.push(row);
      }

      // ignore-duplicates (not merge-duplicates): startup re-fetches the
      // latest slice per chat every launch, so existing rows must be left
      // alone — otherwise fields the user/app mutates (triage, read_at,
      // flagged_at, reactions) would be clobbered back to their Unipile
      // state on every startup. Real-time updates to existing messages
      // (edits, deletes, reactions, seen) arrive via dedicated webhook
      // events that update the row directly.
      //
      // Bulk POST with a JSON-array body per PostgREST's PGRST003 guidance
      // ("reduce write requests. Do Bulk Insert instead of inserting rows
      // one by one.") and with documented transient-error retry.
      let history_upsert_ok = if rows_to_upsert.is_empty() {
        true
      } else if needs_initial_history_backfill {
        let mut ok = true;
        for chunk in rows_to_upsert.chunks(100) {
          match supabase_upsert_batch(
            client,
            &supabase_url,
            &service_key,
            "messages",
            "user_id,external_id",
            "resolution=ignore-duplicates",
            chunk,
            "startup_sync",
          )
          .await
          {
            Ok(n) => msgs_synced += n as u32,
            Err(e) => {
              err_log!("{e}");
              ok = false;
              break;
            }
          }
        }
        ok
      } else {
        match supabase_upsert_batch(
          client,
          &supabase_url,
          &service_key,
          "messages",
          "user_id,external_id",
          "resolution=ignore-duplicates",
          &rows_to_upsert,
          "startup_sync",
        )
        .await
        {
          Ok(n) => {
            msgs_synced += n as u32;
            true
          }
          Err(e) => {
            err_log!("{e}");
            false
          }
        }
      };
      if needs_initial_history_backfill && history_upsert_ok {
        chat_sync_mark_backfilled(
          client,
          &supabase_url,
          &service_key,
          user_id,
          chat_id,
          channel,
          &acc.id,
        )
        .await;
      }

      if !is_group {
        let had_outbound = messages.iter().any(|m| {
          m.get("is_sender")
            .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
            .unwrap_or(false)
        });
        if had_outbound {
          let _ = client
            .patch(format!(
              "{supabase_url}/rest/v1/persons?id=eq.{person_id}&status=eq.pending"
            ))
            .header("apikey", &service_key)
            .header("Authorization", format!("Bearer {service_key}"))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({"status": "approved", "updated_at": chrono::Utc::now().to_rfc3339()}))
            .send()
            .await;
        }
      }
    }
  }
  }

  // Avatar catch-up: full scan at most once per app process.
  if state
    .avatar_catchup_once_per_launch
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_ok()
  {
    let avatar_q = format!(
      "{supabase_url}/rest/v1/persons?user_id=eq.{user_id}&or=(avatar_url.is.null,avatar_stale.eq.true)&select=id&limit=100"
    );
    if let Ok(resp) = client.get(&avatar_q)
      .header("apikey", &service_key).header("Authorization", format!("Bearer {service_key}"))
      .send().await
    {
      if let Ok(persons) = resp.json::<Vec<serde_json::Value>>().await {
        let count = persons.len();
        if count > 0 {
          emit("syncing", &format!("Refreshing {count} avatars…"));
          dev_log!("[startup_sync] avatar catch-up: {count} persons");
        }
        for p in &persons {
          let pid = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
          if pid.is_empty() { continue; }

          let thread_q = format!(
            "{supabase_url}/rest/v1/messages?person_id=eq.{pid}&message_type=neq.group&select=thread_id&order=sent_at.desc&limit=1"
          );
          let tid = match client.get(&thread_q)
            .header("apikey", &service_key).header("Authorization", format!("Bearer {service_key}"))
            .send().await
          {
            Ok(r) if r.status().is_success() => {
              let rows: Vec<serde_json::Value> = r.json().await.unwrap_or_default();
              rows.first().and_then(|r| r.get("thread_id").and_then(|v| v.as_str())).unwrap_or("").to_string()
            }
            _ => continue,
          };
          if tid.is_empty() { continue; }

          let att_url = format!("{base}/api/v1/chat_attendees?chat_id={tid}");
          if let Ok(att_resp) = client.get(&att_url).header("X-API-KEY", &api_key).send().await {
            if let Ok(att_body) = att_resp.json::<serde_json::Value>().await {
              if let Some(items) = att_body.get("items").and_then(|v| v.as_array()) {
                for att in items {
                  let is_self = att.get("is_self")
                    .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
                    .unwrap_or(false);
                  if is_self { continue; }
                  let att_id = att.get("id").and_then(|v| v.as_str()).unwrap_or("");
                  if att_id.is_empty() { continue; }
                  let pic_url = att.get("picture_url").and_then(|v| v.as_str());
                  upload_avatar(
                    client, &api_key, &base, &supabase_url, &service_key,
                    pid, att_id, pic_url,
                  ).await;
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  // Promote pending persons who have outbound messages (user engaged = approved).
  // This catches persons created with wrong direction during sync/backfill.
  let promote_resp = client
    .post(format!("{supabase_url}/rest/v1/rpc/promote_engaged_persons"))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({ "p_user_id": user_id }))
    .send().await;
  let promoted = match promote_resp {
    Ok(r) if r.status().is_success() => {
      r.json::<serde_json::Value>().await.ok()
        .and_then(|v| v.as_i64()).unwrap_or(0) as u32
    }
    _ => 0,
  };

  let mut result = format!("Synced {synced} accounts");
  if !to_remove.is_empty() { result.push_str(&format!(", cleaned {}", to_remove.len())); }
  if msgs_synced > 0 { result.push_str(&format!(", backfilled {msgs_synced} msgs (72h)")); }
  if promoted > 0 { result.push_str(&format!(", promoted {promoted} contacts")); }

  emit("done", &result);
  dev_log!("[startup_sync] {result}");
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
    "X" | "TWITTER" => "x",
    "IMESSAGE" | "APPLE" => "imessage",
    "MOBILE" | "SMS" | "RCS" => "sms",
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
  let is_lid = raw.contains("@lid");
  let mut h = raw
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .replace("@c.us", "")
    .trim()
    .to_string();
  if channel == "whatsapp" && !is_lid && h.chars().all(|c| c.is_ascii_digit()) && !h.is_empty() && h.len() <= 15 {
    h = format!("+{h}");
  }
  if (channel == "imessage" || channel == "sms") && !h.is_empty() {
    let digits: String = h.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 7 && digits.len() <= 15 {
      h = format!("+{digits}");
    }
  }
  if channel == "linkedin" {
    if let Some(stripped) = h.strip_prefix("https://www.linkedin.com/in/") {
      h = stripped.trim_end_matches('/').to_string();
    } else if let Some(stripped) = h.strip_prefix("https://linkedin.com/in/") {
      h = stripped.trim_end_matches('/').to_string();
    } else if let Some(stripped) = h.strip_prefix("http://www.linkedin.com/in/") {
      h = stripped.trim_end_matches('/').to_string();
    } else if let Some(stripped) = h.strip_prefix("http://linkedin.com/in/") {
      h = stripped.trim_end_matches('/').to_string();
    }
  }
  h.to_lowercase()
}

/// Unipile `chat_attendees` item: same field precedence as the DM
/// `other_handle` in backfill (`public_identifier` → `identifier` →
/// `provider_id`).
fn unipile_attendee_handle_raw(att: &serde_json::Value) -> Option<String> {
  att.get("public_identifier")
    .and_then(|v| v.as_str())
    .filter(|s| !s.is_empty())
    .or_else(|| {
      att
        .get("identifier")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    })
    .or_else(|| {
      att
        .get("provider_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    })
    .map(std::string::ToString::to_string)
}

fn unipile_attendee_display_name(att: &serde_json::Value, handle_fallback: &str) -> String {
  att
    .get("name")
    .and_then(|v| v.as_str())
    .filter(|s| !s.is_empty() && *s != "Unknown")
    .map(std::string::ToString::to_string)
    .or_else(|| unipile_attendee_handle_raw(att))
    .unwrap_or_else(|| handle_fallback.to_string())
}

/// Map `chat_attendees[].id` → (raw email handle, display) for per-message
/// person resolution in Gmail-style threads.
fn unipile_email_attendee_index(
  all_attendees: &[serde_json::Value],
) -> std::collections::HashMap<String, (String, String)> {
  all_attendees
    .iter()
    .filter_map(|a| {
      let id = a.get("id").and_then(|v| v.as_str())?.to_string();
      let handle = unipile_attendee_handle_raw(a)?;
      if handle.is_empty() {
        return None;
      }
      let name = unipile_attendee_display_name(a, &handle);
      Some((id, (handle, name)))
    })
    .collect()
}

async fn unipile_resolve_inbound_email_identity(
  client: &reqwest::Client,
  supabase_url: &str,
  service_key: &str,
  user_id: &str,
  channel: &str,
  unipile_account_id: &str,
  normalized_handle: &str,
  display_name: &str,
) -> Option<(String, String)> {
  if normalized_handle.is_empty() {
    return None;
  }
  let mut md = serde_json::Map::new();
  md.insert(
    "email".to_string(),
    serde_json::Value::String(normalized_handle.to_string()),
  );
  let person_resp = client
    .post(format!("{supabase_url}/rest/v1/rpc/backfill_find_or_create_person"))
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({
      "p_user_id": user_id,
      "p_channel": channel,
      "p_handle": normalized_handle,
      "p_display_name": display_name,
      "p_unipile_account_id": unipile_account_id,
      "p_metadata": serde_json::Value::Object(md),
      "p_direction": "inbound"
    }))
    .send()
    .await;
  match person_resp {
    Ok(r) if r.status().is_success() => {
      let body: serde_json::Value = r.json().await.unwrap_or_default();
      let pid = body
        .get("person_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
      let iid = body
        .get("identity_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
      if pid.is_empty() {
        None
      } else {
        Some((pid, iid))
      }
    }
    _ => None,
  }
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
    let chats = match fetch_paginated(client, &chats_base_url, &api_key, 50, Some(state.inner()), Some(&acc.id)).await {
      Ok(c) => c,
      Err(e) => { errors.push(format!("chats fetch: {e}")); continue; }
    };

    for chat in &chats {
      let chat_id = chat.get("id").and_then(|v| v.as_str()).unwrap_or("");
      if chat_id.is_empty() { continue; }

      let is_group = chat.get("type").and_then(|v| v.as_u64()).unwrap_or(0) >= 1;
      let chat_name = chat.get("name").and_then(|v| v.as_str()).unwrap_or("");
      let msg_type = if is_group { "group" } else { "dm" };

      let display_name: String;
      let sender_handle: String;
      let mut dm_attendee_id: Option<String> = None;
      let mut dm_picture_url: Option<String> = None;
      let mut att_phone = String::new();
      let mut pub_id = String::new();

      let attendees_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
      let all_attendees: Vec<serde_json::Value> = match client
        .get(&attendees_url)
        .header("X-API-KEY", &api_key)
        .send()
        .await
      {
        Ok(r) if r.status().is_success() => {
          let body: serde_json::Value = r.json().await.unwrap_or_default();
          body
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
        }
        _ => Vec::new(),
      };

      if is_group {
        display_name = if chat_name.is_empty() { "Group Chat".to_string() } else { chat_name.to_string() };
        sender_handle = normalize_handle(
          chat.get("provider_id")
            .and_then(|v| v.as_str())
            .unwrap_or(chat_id),
          channel
        );
      } else {
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

        att_phone = attendee_info
          .and_then(|a| a.get("specifics"))
          .and_then(|s| s.get("phone_number"))
          .and_then(|v| v.as_str())
          .unwrap_or("")
          .to_string();

        pub_id = attendee_info
          .and_then(|a| a.get("public_identifier").and_then(|v| v.as_str()))
          .or_else(|| chat.get("attendee_public_identifier").and_then(|v| v.as_str()))
          .unwrap_or("")
          .to_string();

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

        // Use the non-self attendee's identifier as the handle (authoritative).
        // Previously this used chat object fields which could contain the account
        // owner's ID on Instagram and other channels. The email-specific
        // self-detection workaround is no longer needed since we use chat_attendees
        // for all channels now.
        if let Some(other) = other_attendee {
          let other_handle = unipile_attendee_handle_raw(other)
            .unwrap_or_else(|| chat_id.to_string());
          sender_handle = normalize_handle(&other_handle, channel);
        } else {
          // Fallback: no attendees, use chat object fields
          sender_handle = normalize_handle(
            chat.get("attendee_public_identifier")
              .and_then(|v| v.as_str())
              .filter(|s| !s.is_empty() && !s.contains("@lid"))
              .or_else(|| chat.get("attendee_provider_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty() && !s.contains("@lid")))
              .or_else(|| chat.get("provider_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()))
              .unwrap_or(chat_id),
            channel
          );
        }
      }

      let mut identity_metadata = serde_json::Map::new();
      if !is_group {
        if !att_phone.is_empty() {
          identity_metadata.insert("phone".to_string(), serde_json::Value::String(att_phone.to_string()));
        }
        if !pub_id.is_empty() {
          identity_metadata.insert("public_identifier".to_string(), serde_json::Value::String(pub_id.to_string()));
        }
        if let Some(pid) = chat.get("attendee_provider_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
          identity_metadata.insert("provider_id".to_string(), serde_json::Value::String(pid.to_string()));
        }
        if channel == "email" {
          identity_metadata.insert("email".to_string(), serde_json::Value::String(sender_handle.clone()));
        }
      }
      let metadata_json = if identity_metadata.is_empty() {
        serde_json::Value::Null
      } else {
        serde_json::Value::Object(identity_metadata)
      };

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
          "p_unipile_account_id": acc.id,
          "p_metadata": metadata_json,
          "p_direction": if is_group { "outbound" } else { "inbound" }
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
          let check_url = format!(
            "{supabase_url}/rest/v1/persons?id=eq.{person_id}&select=avatar_url,avatar_stale"
          );
          let needs_avatar = match client.get(&check_url)
            .header("apikey", &service_key)
            .header("Authorization", format!("Bearer {service_key}"))
            .header("Accept", "application/vnd.pgrst.object+json")
            .send().await
          {
            Ok(r) if r.status().is_success() => {
              let p: serde_json::Value = r.json().await.unwrap_or_default();
              let has_url = p.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("").len() > 10;
              let stale = p.get("avatar_stale").and_then(|v| v.as_bool()).unwrap_or(true);
              !has_url || stale
            }
            _ => true,
          };
          if needs_avatar {
            upload_avatar(
              client, &api_key, &base, &supabase_url, &service_key,
              &person_id, att_id, dm_picture_url.as_deref(),
            ).await;
          }
        }
      }

      let chat_folder = chat.get("folder").and_then(|v| v.as_str()).unwrap_or("");

      let msgs_base_url = format!("{base}/api/v1/chats/{chat_id}/messages?limit=100");

      let attendee_map: std::collections::HashMap<String, String> = if is_group {
        all_attendees
          .iter()
          .filter_map(|a| {
            let id = a.get("id").and_then(|v| v.as_str())?;
            let name = a
              .get("name")
              .and_then(|v| v.as_str())
              .filter(|s| !s.is_empty())
              .or_else(|| {
                a.get("public_identifier")
                  .and_then(|v| v.as_str())
                  .filter(|s| !s.is_empty())
              })
              .or_else(|| a.get("provider_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))?;
            Some((id.to_string(), name.to_string()))
          })
          .collect()
      } else {
        std::collections::HashMap::new()
      };

      let chat_error_start = errors.len();
      let messages = match fetch_paginated(
        client,
        &msgs_base_url,
        &api_key,
        HISTORY_FETCH_MAX_PAGES,
        Some(state.inner()),
        Some(&acc.id),
      )
      .await
      {
        Ok(m) => m,
        Err(e) => { errors.push(format!("msgs fetch {chat_id}: {e}")); continue; }
      };

      // Gmail threads legitimately contain multiple senders. For email we
      // resolve the sender per-message (not per-chat) so senders in one
      // thread do not collapse onto a single person.
      let email_sender_map: std::collections::HashMap<String, (String, String)> =
        if channel == "email" && !is_group {
          unipile_email_attendee_index(&all_attendees)
        } else {
          std::collections::HashMap::new()
        };
      let mut resolved_senders: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();

      for msg in &messages {
        let external_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if external_id.is_empty() { continue; }

        let timestamp = msg.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        if timestamp.is_empty() { continue; }

        let body_text = msg.get("text").and_then(|v| v.as_str());
        let msg_subject = msg.get("subject").and_then(|v| v.as_str());

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
          })
          .or_else(|| {
            if is_group { Some("Unknown".to_string()) } else { None }
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

        // Per-message sender resolution for email. For IM DMs the chat-level
        // person is correct. For inbound email we look up the actual sender
        // in the thread attendees and find/create the right person. If
        // Unipile omits `sender_attendee_id`, we fall back to `from` +
        // `sender_public_identifier` matching the attendee list.
        let (msg_person_id, msg_identity_id) = if channel == "email" && !is_group && !is_sender {
          let sender_att_id = msg
            .get("sender_attendee_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
          let from_pub = msg
            .get("sender_public_identifier")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

          let mut peer: Option<(String, String)> = None;
          if let Some(t) = email_sender_map.get(sender_att_id) {
            peer = Some((t.0.clone(), t.1.clone()));
          } else if let Some(frm) = from_pub {
            let nfrm = normalize_handle(frm, channel);
            for a in &all_attendees {
              if let Some(rh) = unipile_attendee_handle_raw(a) {
                if normalize_handle(&rh, channel) == nfrm {
                  let name = unipile_attendee_display_name(a, &rh);
                  peer = Some((rh, name));
                  break;
                }
              }
            }
            if peer.is_none() {
              let disp = sender_name
                .clone()
                .unwrap_or_else(|| frm.to_string());
              peer = Some((frm.to_string(), disp));
            }
          }

          match &peer {
            None => (person_id.clone(), identity_id.clone()),
            Some((raw_handle, display)) => {
              let sender_h = normalize_handle(raw_handle, channel);
              if sender_h == sender_handle || sender_h.is_empty() {
                (person_id.clone(), identity_id.clone())
              } else if let Some(cached) = resolved_senders.get(&sender_h) {
                cached.clone()
              } else if let Some(pair) = unipile_resolve_inbound_email_identity(
                client,
                &supabase_url,
                &service_key,
                &user_id,
                channel,
                &acc.id,
                &sender_h,
                display,
              )
              .await
              {
                resolved_senders.insert(sender_h, pair.clone());
                pair
              } else {
                (person_id.clone(), identity_id.clone())
              }
            }
          }
        } else {
          (person_id.clone(), identity_id.clone())
        };

        let mut row = serde_json::json!({
          "user_id": user_id,
          "person_id": msg_person_id,
          "identity_id": if msg_identity_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(msg_identity_id.clone()) },
          "external_id": external_id,
          "channel": channel,
          "direction": direction,
          "message_type": msg_type,
          "body_text": body_text,
          "subject": msg_subject,
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
        });
        if !is_sender {
          row.as_object_mut().unwrap().insert("read_at".into(), serde_json::Value::String(chrono::Utc::now().to_rfc3339()));
        }

        let insert_resp = client
          .post(format!("{supabase_url}/rest/v1/messages?on_conflict=user_id,external_id"))
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

      if !is_group {
        let had_outbound = messages.iter().any(|m| {
          m.get("is_sender")
            .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
            .unwrap_or(false)
        });
        if had_outbound {
          let _ = client
            .patch(format!(
              "{supabase_url}/rest/v1/persons?id=eq.{person_id}&status=eq.pending"
            ))
            .header("apikey", &service_key)
            .header("Authorization", format!("Bearer {service_key}"))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({"status": "approved", "updated_at": chrono::Utc::now().to_rfc3339()}))
            .send()
            .await;
        }
      }

      if errors.len() == chat_error_start {
        chat_sync_mark_backfilled(
          client,
          &supabase_url,
          &service_key,
          &user_id,
          chat_id,
          channel,
          &acc.id,
        )
        .await;
        total_chats += 1;
      } else {
        dev_log!("[backfill_messages] not marking {chat_id} backfilled after write errors");
      }
    }
  }

  match backfill_x_dms(client, &user_id, &supabase_url, &service_key).await {
    Ok((msgs, chats)) => {
      total_messages += msgs;
      total_chats += chats;
    }
    Err(e) => errors.push(format!("X DMs: {e}")),
  }

  match backfill_imessage(client, &user_id, &supabase_url, &service_key).await {
    Ok((msgs, chats)) => {
      total_messages += msgs;
      total_chats += chats;
    }
    Err(e) => errors.push(format!("iMessage: {e}")),
  }

  let mut result = format!("Backfilled {} messages from {} chats", total_messages, total_chats);
  if !errors.is_empty() {
    let first_errors: Vec<&str> = errors.iter().take(3).map(|s| s.as_str()).collect();
    result.push_str(&format!(" (errors: {})", first_errors.join("; ")));
  }
  Ok(result)
}

#[tauri::command]
async fn sync_chat(
  chat_id: String,
  user_id: String,
  person_id: String,
  channel: String,
  message_type: String,
  identity_id: Option<String>,
  unipile_account_id: Option<String>,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let account_id = match &unipile_account_id {
    Some(a) if !a.is_empty() => a.clone(),
    _ => return Ok("no_account".to_string()),
  };

  if channel == "x" || channel == "imessage" {
    return Ok("skip_non_unipile".to_string());
  }

  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;

  let needs_initial_history_backfill =
    chat_sync_history_pending(client, &supabase_url, &service_key, &user_id, &chat_id).await;

  let messages = if needs_initial_history_backfill {
    let msgs_url = format!("{base}/api/v1/chats/{chat_id}/messages?limit=100");
    match fetch_paginated(
      client,
      &msgs_url,
      &api_key,
      HISTORY_FETCH_MAX_PAGES,
      Some(state.inner()),
      Some(&account_id),
    )
    .await
    {
      Ok(m) => m,
      Err(e) => return Err(format!("sync_chat fetch: {e}")),
    }
  } else {
    let last_resp = client
      .get(format!(
        "{supabase_url}/rest/v1/messages?thread_id=eq.{chat_id}&user_id=eq.{user_id}&select=sent_at&order=sent_at.desc&limit=1"
      ))
      .header("apikey", &service_key)
      .header("Authorization", format!("Bearer {service_key}"))
      .send().await;

    let after_ts = match last_resp {
      Ok(r) if r.status().is_success() => {
        let rows: Vec<serde_json::Value> = r.json().await.unwrap_or_default();
        rows.first()
          .and_then(|r| r.get("sent_at").and_then(|v| v.as_str()))
          .and_then(|ts| chrono::DateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f%:z").ok()
            .or_else(|| chrono::DateTime::parse_from_rfc3339(ts).ok()))
          .map(|dt| {
            let self_heal_floor = chrono::Utc::now() - chrono::Duration::hours(SYNC_SELF_HEAL_HOURS);
            std::cmp::min(dt.with_timezone(&chrono::Utc), self_heal_floor)
              .format("%Y-%m-%dT%H:%M:%S%.3fZ")
              .to_string()
          })
      }
      _ => None,
    };

    let msgs_url = match &after_ts {
      Some(ts) => format!("{base}/api/v1/chats/{chat_id}/messages?limit=50&after={ts}"),
      None => format!("{base}/api/v1/chats/{chat_id}/messages?limit=50"),
    };
    match fetch_paginated(client, &msgs_url, &api_key, 3, Some(state.inner()), Some(&account_id)).await {
      Ok(m) => m,
      Err(e) => return Err(format!("sync_chat fetch: {e}")),
    }
  };

  if messages.is_empty() {
    if needs_initial_history_backfill {
      chat_sync_mark_backfilled(
        client,
        &supabase_url,
        &service_key,
        &user_id,
        &chat_id,
        &channel,
        &account_id,
      )
      .await;
    }
    return Ok("0".to_string());
  }

  let is_group = message_type == "group";
  let needs_attendees = is_group || channel == "email";
  let all_attendees: Vec<serde_json::Value> = if needs_attendees {
    let att_url = format!("{base}/api/v1/chat_attendees?chat_id={chat_id}");
    match client.get(&att_url).header("X-API-KEY", &api_key).send().await {
      Ok(r) if r.status().is_success() => {
        let body: serde_json::Value = r.json().await.unwrap_or_default();
        body.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default()
      }
      _ => Vec::new(),
    }
  } else {
    Vec::new()
  };

  let attendee_map: std::collections::HashMap<String, String> = if is_group {
    all_attendees.iter().filter_map(|a| {
      let id = a.get("id").and_then(|v| v.as_str())?;
      let name = a.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .or_else(|| a.get("public_identifier").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
        .or_else(|| a.get("provider_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))?;
      Some((id.to_string(), name.to_string()))
    }).collect()
  } else {
    std::collections::HashMap::new()
  };

  // See backfill_messages: email threads can contain multiple senders, so
  // resolve per-message rather than reusing the chat-level person.
  let email_sender_map: std::collections::HashMap<String, (String, String)> =
    if channel == "email" && !is_group {
      unipile_email_attendee_index(&all_attendees)
    } else {
      std::collections::HashMap::new()
    };
  let thread_peer_handle = if channel == "email" && !is_group {
    all_attendees
      .iter()
      .find(|a| {
        !a
          .get("is_self")
          .map(|v| v.as_bool().unwrap_or(v.as_u64().unwrap_or(0) == 1))
          .unwrap_or(false)
      })
      .and_then(unipile_attendee_handle_raw)
      .map(|h| normalize_handle(&h, &channel))
      .unwrap_or_default()
  } else {
    String::new()
  };
  let mut resolved_senders: std::collections::HashMap<String, (String, String)> =
    std::collections::HashMap::new();

  let mut rows_to_upsert: Vec<serde_json::Value> = Vec::with_capacity(messages.len());

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
    let msg_subject = msg.get("subject").and_then(|v| v.as_str());
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
          msg.get("sender_public_identifier")
            .and_then(|v| v.as_str())
            .map(|s| s.replace("@s.whatsapp.net", "").replace("@lid", ""))
            .map(|s| if s.chars().all(|c| c.is_ascii_digit()) { format!("+{s}") } else { s })
        })
        .or(Some("Unknown".to_string()))
    } else {
      None
    };

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

    // PGRST102 requires identical keys across all rows in a bulk upsert,
    // so `read_at` is always present (null for outbound).
    let read_at_val = if is_sender {
      serde_json::Value::Null
    } else {
      serde_json::Value::String(chrono::Utc::now().to_rfc3339())
    };

    // Per-message sender resolution for inbound email (see backfill_messages).
    let (msg_person_id, msg_identity_id) = if channel == "email" && !is_group && !is_sender {
      let id_fallback = || {
        (
          person_id.clone(),
          identity_id
            .clone()
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
        )
      };
      let sender_att_id = msg
        .get("sender_attendee_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
      let from_pub = msg
        .get("sender_public_identifier")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

      let mut peer: Option<(String, String)> = None;
      if let Some(t) = email_sender_map.get(sender_att_id) {
        peer = Some((t.0.clone(), t.1.clone()));
      } else if let Some(frm) = from_pub {
        let nfrm = normalize_handle(frm, &channel);
        for a in &all_attendees {
          if let Some(rh) = unipile_attendee_handle_raw(a) {
            if normalize_handle(&rh, &channel) == nfrm {
              let name = unipile_attendee_display_name(a, &rh);
              peer = Some((rh, name));
              break;
            }
          }
        }
        if peer.is_none() {
          let disp = sender_name
            .clone()
            .unwrap_or_else(|| frm.to_string());
          peer = Some((frm.to_string(), disp));
        }
      }

      match &peer {
        None => id_fallback(),
        Some((raw_handle, display)) => {
          let sender_h = normalize_handle(raw_handle, &channel);
          if sender_h == thread_peer_handle || sender_h.is_empty() {
            id_fallback()
          } else if let Some(cached) = resolved_senders.get(&sender_h) {
            (
              cached.0.clone(),
              if cached.1.is_empty() {
                serde_json::Value::Null
              } else {
                serde_json::Value::String(cached.1.clone())
              },
            )
          } else if let Some((pid, iid)) = unipile_resolve_inbound_email_identity(
            client,
            &supabase_url,
            &service_key,
            &user_id,
            &channel,
            &account_id,
            &sender_h,
            display,
          )
          .await
          {
            resolved_senders.insert(sender_h, (pid.clone(), iid.clone()));
            (
              pid,
              if iid.is_empty() {
                serde_json::Value::Null
              } else {
                serde_json::Value::String(iid)
              },
            )
          } else {
            id_fallback()
          }
        }
      }
    } else {
      (
        person_id.clone(),
        identity_id
          .clone()
          .map(serde_json::Value::String)
          .unwrap_or(serde_json::Value::Null),
      )
    };

    let row = serde_json::json!({
      "user_id": user_id,
      "person_id": msg_person_id,
      "identity_id": msg_identity_id,
      "external_id": external_id,
      "channel": channel,
      "direction": direction,
      "message_type": message_type,
      "body_text": body_text,
      "subject": msg_subject,
      "attachments": attachments,
      "thread_id": chat_id,
      "sent_at": timestamp,
      "sender_name": sender_name,
      "reactions": reactions,
      "triage": "unclassified",
      "unipile_account_id": account_id,
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
      "read_at": read_at_val,
    });

    rows_to_upsert.push(row);
  }

  // Bulk upsert — merge-duplicates because sync_chat is the on-demand
  // refresh path: the user explicitly asked to resync, so newer provider
  // state (reactions, read, edits) should overwrite the existing row.
  let (synced, upsert_ok) = if rows_to_upsert.is_empty() {
    (0u32, true)
  } else if needs_initial_history_backfill {
    let mut n = 0u32;
    let mut ok = true;
    for chunk in rows_to_upsert.chunks(100) {
      match supabase_upsert_batch(
        client,
        &supabase_url,
        &service_key,
        "messages",
        "user_id,external_id",
        "resolution=merge-duplicates",
        chunk,
        "sync_chat",
      )
      .await
      {
        Ok(c) => n += c as u32,
        Err(e) => {
          err_log!("{e}");
          ok = false;
          break;
        }
      }
    }
    (n, ok)
  } else {
    match supabase_upsert_batch(
      client,
      &supabase_url,
      &service_key,
      "messages",
      "user_id,external_id",
      "resolution=merge-duplicates",
      &rows_to_upsert,
      "sync_chat",
    )
    .await
    {
      Ok(n) => (n as u32, true),
      Err(e) => {
        err_log!("{e}");
        (0u32, false)
      }
    }
  };

  if needs_initial_history_backfill && upsert_ok {
    chat_sync_mark_backfilled(
      client,
      &supabase_url,
      &service_key,
      &user_id,
      &chat_id,
      &channel,
      &account_id,
    )
    .await;
  }

  Ok(format!("{synced}"))
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
  bridges: State<'_, on_device::BridgeManager>,
) -> Result<String, String> {
  if channel == "x" {
    return send_x_dm(
      &state.http, &chat_id, &text, &user_id, &person_id,
      account_id.as_deref(),
    ).await;
  }

  if channel == "imessage" {
    return send_imessage_dm(
      &state.http, &chat_id, &text, &user_id, &person_id,
    ).await;
  }

  // On-device bridges (Instagram / Messenger via meta-bridge sidecar). The
  // `account_id` is the local bridge id; routing is keyed by that, not the
  // per-thread chat_id.
  if on_device::is_on_device_channel(&channel) {
    let bridge_account = account_id
      .as_deref()
      .ok_or_else(|| "on-device send requires account_id".to_string())?;
    if chat_id.is_empty() {
      return Err("on-device send requires thread_id (chat_id)".to_string());
    }
    let external_id = on_device::commands::send_via_bridge(
      &bridges, bridge_account, &chat_id, &text,
    ).await?;

    persist_outbound(
      &state.http, &user_id, &person_id, &channel, &message_type,
      &text, &chat_id, &external_id, &serde_json::json!([]),
      Some(bridge_account),
    ).await.unwrap_or_else(|e| dev_log!("[send_message] on-device persist warning: {e}"));

    log_send_audit(
      &state.http, &user_id, &person_id, &channel, &chat_id, &chat_id,
      Some(bridge_account), "sent", None,
    ).await;

    return Ok(external_id);
  }

  if chat_id.is_empty() {
    return Err("No chat_id provided — cannot send without a target chat".to_string());
  }

  let (api_key, base) = unipile_config()?;
  let client = &state.http;
  let aid = account_id.as_deref().unwrap_or("");

  if unipile_account_is_paused(state.inner(), aid) {
    return Err("unipile_account_paused:remote actions cool-down after 403 — try again later".to_string());
  }

  // Token-bucket check — scaled by 7-day session ramp.
  let scale = warmup_scale_for(state.inner(), aid);
  if let Err(code) = state.limiter.check_and_consume(aid, &channel, scale) {
    dev_log!("[send_message] {code} account={aid} scale={scale}");
    log_send_audit(
      client, &user_id, &person_id, &channel, &chat_id, &chat_id,
      account_id.as_deref(), "error", Some(&code),
    ).await;
    return Err(code);
  }

  dev_log!("[send_message] person={person_id} channel={channel} chat_id={chat_id} account_id={aid} scale={scale}");

  let url = format!("{base}/api/v1/chats/{chat_id}/messages");
  let mut form = reqwest::multipart::Form::new().text("text", text.clone());
  if !aid.is_empty() { form = form.text("account_id", aid.to_string()); }
  if let Some(ref qid) = quote_id { if !qid.is_empty() { form = form.text("quote_id", qid.clone()); } }

  // Humanize typing indicator. Without this, Unipile sends with no
  // typing delay — an obvious tell against real users who have read
  // receipts + typing bubbles. Target channels honor Unipile's
  // `typing_duration` (seconds). Email / X / iMessage don't, so skip.
  let td_override = typing_duration.as_deref().filter(|s| !s.is_empty());
  let typing_channels = matches!(channel.as_str(), "instagram" | "whatsapp" | "linkedin" | "messenger" | "telegram");
  if let Some(td) = td_override {
    form = form.text("typing_duration", td.to_string());
  } else if typing_channels {
    let seconds = humanized_typing_duration_seconds(&text);
    form = form.text("typing_duration", format!("{seconds:.1}"));
  }

  let response = client.post(url).header("X-API-KEY", &api_key).multipart(form).send()
    .await.map_err(|e| format!("Send failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();

  if !status.is_success() {
    if status == reqwest::StatusCode::FORBIDDEN && !aid.is_empty() {
      record_unipile_403_cooldown(state.inner(), aid);
    }
    log_send_audit(
      client, &user_id, &person_id, &channel, &chat_id, &chat_id,
      account_id.as_deref(), "error", Some(&format!("{status}: {body}")),
    ).await;
    return Err(format!("Send error {status}: {body}"));
  }

  let resp: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
  let external_id = resp.get("message_id")
    .or_else(|| resp.get("id"))
    .and_then(|v| v.as_str())
    .unwrap_or("");

  persist_outbound(
    &state.http, &user_id, &person_id, &channel, &message_type,
    &text, &chat_id, external_id, &serde_json::json!([]),
    account_id.as_deref(),
  ).await.unwrap_or_else(|e| dev_log!("[send_message] persist warning: {e}"));

  log_send_audit(
    client, &user_id, &person_id, &channel, &chat_id, &chat_id,
    account_id.as_deref(), "sent", None,
  ).await;

  Ok(external_id.to_string())
}

async fn log_send_audit(
  client: &reqwest::Client,
  user_id: &str,
  person_id: &str,
  channel: &str,
  frontend_chat_id: &str,
  resolved_chat_id: &str,
  resolved_account_id: Option<&str>,
  outcome: &str,
  detail: Option<&str>,
) {
  let sb_url = match std::env::var("VITE_SUPABASE_URL") { Ok(v) => v, Err(_) => return };
  let sb_key = match std::env::var("SUPABASE_SERVICE_ROLE_KEY") { Ok(v) => v, Err(_) => return };

  let row = serde_json::json!({
    "user_id": user_id,
    "person_id": person_id,
    "channel": channel,
    "frontend_chat_id": frontend_chat_id,
    "resolved_chat_id": resolved_chat_id,
    "resolved_account_id": resolved_account_id.unwrap_or(""),
    "outcome": outcome,
    "detail": detail.unwrap_or(""),
  });

  let _ = client.post(format!("{sb_url}/rest/v1/send_audit_log"))
    .header("apikey", &sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .header("Content-Type", "application/json")
    .header("Prefer", "return=minimal")
    .body(row.to_string())
    .send().await;
}

#[tauri::command]
async fn chat_action(
  user_id: String,
  person_id: String,
  action: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  dev_log!("[chat_action] person={person_id} action={action}");
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;

  let threads_resp = client
    .post(format!(
      "{supabase_url}/rest/v1/rpc/get_person_threads"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({
      "p_user_id": user_id,
      "p_person_id": person_id
    }))
    .send().await
    .map_err(|e| format!("chat_action: fetch threads failed: {e}"))?;

  if !threads_resp.status().is_success() {
    let status = threads_resp.status();
    let text = threads_resp.text().await.unwrap_or_default();
    return Err(format!("chat_action: get_person_threads {status}: {text}"));
  }

  let threads: Vec<serde_json::Value> = threads_resp.json().await.unwrap_or_default();

  let mut synced = 0u32;
  for thread in &threads {
    let thread_id = thread.get("thread_id").and_then(|v| v.as_str()).unwrap_or("");
    let channel = thread.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    if thread_id.is_empty() { continue; }

    let (unipile_action, unipile_value) = match (action.as_str(), channel) {
      ("pin", "whatsapp") => ("setPinnedStatus", serde_json::Value::Bool(true)),
      ("unpin", "whatsapp") => ("setPinnedStatus", serde_json::Value::Bool(false)),
      ("mark_unread", "whatsapp") | ("mark_unread", "linkedin") =>
        ("setReadStatus", serde_json::Value::Bool(false)),
      ("mark_read", "whatsapp") | ("mark_read", "linkedin") =>
        ("setReadStatus", serde_json::Value::Bool(true)),
      _ => continue,
    };

    let url = format!("{base}/api/v1/chats/{thread_id}");
    let body = serde_json::json!({ "action": unipile_action, "value": unipile_value });

    match client.patch(&url)
      .header("X-API-KEY", &api_key)
      .header("Content-Type", "application/json")
      .json(&body)
      .send().await
    {
      Ok(r) if r.status().is_success() => { synced += 1; }
      Ok(r) if r.status().as_u16() == 404 => {
        // Terminal per Unipile docs ("errors/resource_not_found"):
        // the thread's provider chat_id is no longer valid on Unipile's
        // side (e.g. the chat was deleted, the account was reconnected,
        // or the `thread_id` is stale from before a reconcile). Don't
        // retry — the stale mapping will be removed on the next
        // `reconcile_chats` run, which prunes local chat_provider_ids
        // not present in Unipile's current chat list.
        dev_log!("[chat_action] {channel} {unipile_action}: stale thread_id {thread_id} (404), skipping. Run reconcile to clean up.");
      }
      Ok(r) => {
        let status = r.status();
        let text = r.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::FORBIDDEN {
          dev_log!("[chat_action] Unipile 403 (account may be restricted): {text}");
        } else {
          dev_log!("[chat_action] Unipile {channel} {unipile_action} failed: {status} {text}");
        }
      }
      Err(e) => {
        dev_log!("[chat_action] Unipile {channel} request error: {e}");
      }
    }
  }

  dev_log!("[chat_action] synced {synced}/{} threads", threads.len());
  Ok(format!("{synced}"))
}

#[tauri::command]
async fn email_flag_action(
  email_external_id: String,
  flagged: bool,
  state: State<'_, AppState>,
) -> Result<String, String> {
  dev_log!("[email_flag_action] email={email_external_id} flagged={flagged}");
  let (api_key, base) = unipile_config()?;
  let client = &state.http;

  let url = format!("{base}/api/v1/emails/{email_external_id}");
  let body = if flagged {
    serde_json::json!({ "folders": ["STARRED"] })
  } else {
    serde_json::json!({ "folders": [] })
  };

  match client.put(&url)
    .header("X-API-KEY", &api_key)
    .header("Content-Type", "application/json")
    .json(&body)
    .send().await
  {
    Ok(r) if r.status().is_success() => {
      dev_log!("[email_flag_action] OK for {email_external_id}");
      Ok("ok".to_string())
    }
    Ok(r) => {
      let status = r.status();
      let text = r.text().await.unwrap_or_default();
      dev_log!("[email_flag_action] failed: {status} {text}");
      Err(format!("email_flag_action: {status}"))
    }
    Err(e) => {
      dev_log!("[email_flag_action] request error: {e}");
      Err(format!("email_flag_action: {e}"))
    }
  }
}

#[tauri::command]
async fn sync_email_flags(user_id: String, state: State<'_, AppState>) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url = std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY").map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;

  let accounts = match fetch_accounts_inner(client).await {
    Ok(a) => a,
    Err(e) => { dev_log!("[sync_email_flags] account fetch: {e}"); return Ok("skip".to_string()); }
  };
  let email_accs: Vec<&UnipileAccount> = accounts.iter()
    .filter(|a| channel_from_type(&a.account_type) == "email" && (a.status == "OK" || a.status == "RUNNING"))
    .collect();
  if email_accs.is_empty() { return Ok("no email accounts".to_string()); }

  let mut starred_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
  for acc in &email_accs {
    let url = format!("{base}/api/v1/emails?account_id={}&folder=STARRED&limit=100", acc.id);
    match fetch_paginated(client, &url, &api_key, 3, Some(state.inner()), Some(&acc.id)).await {
      Ok(emails) => {
        for em in &emails {
          if let Some(id) = em.get("id").and_then(|v| v.as_str()) {
            starred_ids.insert(id.to_string());
          }
        }
      }
      Err(e) => dev_log!("[sync_email_flags] starred fetch {}: {e}", acc.id),
    }
  }

  let db_url = format!(
    "{supabase_url}/rest/v1/messages?select=id,external_id&user_id=eq.{user_id}&channel=eq.email&flagged_at=not.is.null"
  );
  let db_flagged: Vec<serde_json::Value> = match client.get(&db_url)
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send().await
  {
    Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
    _ => Vec::new(),
  };

  let mut changes = 0u32;

  for row in &db_flagged {
    let ext_id = row.get("external_id").and_then(|v| v.as_str()).unwrap_or("");
    let db_id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if ext_id.is_empty() || db_id.is_empty() { continue; }

    if !starred_ids.contains(ext_id) {
      let patch_url = format!("{supabase_url}/rest/v1/messages?id=eq.{db_id}");
      if let Ok(r) = client.patch(&patch_url)
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "flagged_at": serde_json::Value::Null }))
        .send().await
      {
        if r.status().is_success() { changes += 1; }
      }
    }
  }

  let db_ext_ids: std::collections::HashSet<String> = db_flagged.iter()
    .filter_map(|r| r.get("external_id").and_then(|v| v.as_str()).map(String::from))
    .collect();

  let now = chrono::Utc::now().to_rfc3339();
  for ext_id in &starred_ids {
    if !db_ext_ids.contains(ext_id) {
      let patch_url = format!(
        "{supabase_url}/rest/v1/messages?external_id=eq.{ext_id}&user_id=eq.{user_id}"
      );
      if let Ok(r) = client.patch(&patch_url)
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "flagged_at": now }))
        .send().await
      {
        if r.status().is_success() { changes += 1; }
      }
    }
  }

  if changes > 0 {
    dev_log!("[sync_email_flags] {changes} flag changes synced");
  }
  Ok(format!("{changes}"))
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
  if chat_id.is_empty() {
    return Err("No chat_id provided — cannot send without a target chat".to_string());
  }

  let (api_key, base) = unipile_config()?;
  let client = &state.http;
  let aid = account_id.as_deref().unwrap_or("");

  if unipile_account_is_paused(state.inner(), aid) {
    return Err("unipile_account_paused:remote actions cool-down after 403 — try again later".to_string());
  }

  let scale = warmup_scale_for(state.inner(), aid);
  if let Err(code) = state.limiter.check_and_consume(aid, &channel, scale) {
    dev_log!("[send_attachment] {code} account={aid} scale={scale}");
    log_send_audit(
      client, &user_id, &person_id, &channel, &chat_id, &chat_id,
      account_id.as_deref(), "error", Some(&code),
    ).await;
    return Err(code);
  }

  let raw = base64::Engine::decode(&base64_engine(), &file_data)
    .map_err(|e| format!("base64 decode: {e}"))?;

  let body_text = text.clone().unwrap_or_default();

  dev_log!("[send_attachment] person={person_id} channel={channel} chat_id={chat_id} file={file_name} scale={scale}");

  let file_part = reqwest::multipart::Part::bytes(raw)
    .file_name(file_name.clone())
    .mime_str(&mime_type)
    .map_err(|e| format!("mime: {e}"))?;

  let mut form = reqwest::multipart::Form::new().part("attachments", file_part);
  if !body_text.is_empty() { form = form.text("text", body_text); }
  if !aid.is_empty() { form = form.text("account_id", aid.to_string()); }
  if let Some(ref qid) = quote_id { if !qid.is_empty() { form = form.text("quote_id", qid.clone()); } }

  let url = format!("{base}/api/v1/chats/{chat_id}/messages");
  let response = client.post(&url).header("X-API-KEY", &api_key).multipart(form).send().await
    .map_err(|e| format!("Send attachment failed: {e}"))?;

  let status = response.status();
  let body = response.text().await.unwrap_or_default();

  if !status.is_success() {
    if status == reqwest::StatusCode::FORBIDDEN && !aid.is_empty() {
      record_unipile_403_cooldown(state.inner(), aid);
    }
    log_send_audit(
      client, &user_id, &person_id, &channel, &chat_id, &chat_id,
      account_id.as_deref(), "error", Some(&format!("attachment {status}: {body}")),
    ).await;
    return Err(format!("Send attachment error {status}: {body}"));
  }

  let resp: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
  let external_id = resp.get("message_id")
    .or_else(|| resp.get("id"))
    .and_then(|v| v.as_str())
    .unwrap_or("");

  let att_json = serde_json::json!([{ "name": file_name, "mimetype": mime_type }]);
  let display_text = text.unwrap_or_default();

  persist_outbound(
    &state.http, &user_id, &person_id, &channel, &message_type,
    &display_text, &chat_id, external_id, &att_json, account_id.as_deref(),
  ).await.unwrap_or_else(|e| dev_log!("[send_attachment] persist warning: {e}"));

  log_send_audit(
    client, &user_id, &person_id, &channel, &chat_id, &chat_id,
    account_id.as_deref(), "sent", Some("attachment"),
  ).await;

  Ok(external_id.to_string())
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
  Ok(String::new())
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
  Ok(String::new())
}

// ─── X / TWITTER INTEGRATION ─────────────────────────────────────────────────

fn generate_code_verifier() -> String {
  let mut bytes = [0u8; 32];
  getrandom::getrandom(&mut bytes).expect("failed to get random bytes");
  base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

fn generate_code_challenge(verifier: &str) -> String {
  use sha2::Digest;
  let hash = sha2::Sha256::digest(verifier.as_bytes());
  base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, hash)
}

fn generate_random_state() -> String {
  let mut bytes = [0u8; 24];
  getrandom::getrandom(&mut bytes).expect("failed to get random bytes");
  base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[tauri::command]
async fn connect_x_account(
  user_id: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (client_id, _) = x_config()?;

  let code_verifier = generate_code_verifier();
  let code_challenge = generate_code_challenge(&code_verifier);
  let oauth_state = generate_random_state();

  let supabase_url = std::env::var("VITE_SUPABASE_URL")
    .map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let sb_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let row = serde_json::json!({
    "state": oauth_state,
    "code_verifier": code_verifier,
    "user_id": user_id,
  });

  let resp = state.http
    .post(format!("{supabase_url}/rest/v1/x_oauth_state"))
    .header("apikey", &sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .header("Content-Type", "application/json")
    .json(&row)
    .send()
    .await
    .map_err(|e| format!("Failed to store PKCE state: {e}"))?;

  if !resp.status().is_success() {
    let b = resp.text().await.unwrap_or_default();
    return Err(format!("Failed to store PKCE state: {b}"));
  }

  let redirect_uri = format!("{supabase_url}/functions/v1/x-account-callback");
  let scopes = "dm.read dm.write tweet.read users.read offline.access";
  let auth_url = format!(
    "https://twitter.com/i/oauth2/authorize?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
    urlencoding::encode(&client_id),
    urlencoding::encode(&redirect_uri),
    urlencoding::encode(scopes),
    urlencoding::encode(&oauth_state),
    urlencoding::encode(&code_challenge),
  );

  Ok(auth_url)
}

fn decrypt_x_params(params: &serde_json::Value) -> Result<serde_json::Value, String> {
  use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead, Nonce};
  use base64::Engine;

  let encrypted = match params.get("encrypted").and_then(|v| v.as_str()) {
    Some(e) => e,
    None => return Ok(params.clone()),
  };

  let key_b64 = std::env::var("TOKEN_ENCRYPTION_KEY")
    .map_err(|_| "TOKEN_ENCRYPTION_KEY not set — cannot decrypt X tokens".to_string())?;
  let key_bytes = base64::engine::general_purpose::STANDARD
    .decode(&key_b64)
    .map_err(|e| format!("TOKEN_ENCRYPTION_KEY decode: {e}"))?;
  if key_bytes.len() != 32 {
    return Err(format!("TOKEN_ENCRYPTION_KEY must be 32 bytes, got {}", key_bytes.len()));
  }

  let combined = base64::engine::general_purpose::STANDARD
    .decode(encrypted)
    .map_err(|e| format!("encrypted params decode: {e}"))?;
  if combined.len() < 12 {
    return Err("encrypted params too short".to_string());
  }

  let nonce = Nonce::from_slice(&combined[..12]);
  let ciphertext = &combined[12..];

  let cipher = Aes256Gcm::new_from_slice(&key_bytes)
    .map_err(|e| format!("AES key init: {e}"))?;
  let plaintext = cipher.decrypt(nonce, ciphertext)
    .map_err(|_| "X token decryption failed — key mismatch or corrupted data".to_string())?;

  serde_json::from_slice(&plaintext)
    .map_err(|e| format!("decrypted params parse: {e}"))
}

fn encrypt_x_params(params: &serde_json::Value) -> Result<serde_json::Value, String> {
  use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead, Nonce};
  use base64::Engine;

  let key_b64 = match std::env::var("TOKEN_ENCRYPTION_KEY") {
    Ok(k) => k,
    Err(_) => return Ok(params.clone()),
  };
  let key_bytes = base64::engine::general_purpose::STANDARD
    .decode(&key_b64)
    .map_err(|e| format!("TOKEN_ENCRYPTION_KEY decode: {e}"))?;
  if key_bytes.len() != 32 {
    return Err(format!("TOKEN_ENCRYPTION_KEY must be 32 bytes, got {}", key_bytes.len()));
  }

  let cipher = Aes256Gcm::new_from_slice(&key_bytes)
    .map_err(|e| format!("AES key init: {e}"))?;

  let mut iv = [0u8; 12];
  getrandom::getrandom(&mut iv).map_err(|e| format!("RNG: {e}"))?;
  let nonce = Nonce::from_slice(&iv);

  let plaintext = serde_json::to_vec(params)
    .map_err(|e| format!("params serialize: {e}"))?;
  let ciphertext = cipher.encrypt(nonce, plaintext.as_slice())
    .map_err(|e| format!("encryption: {e}"))?;

  let mut combined = Vec::with_capacity(12 + ciphertext.len());
  combined.extend_from_slice(&iv);
  combined.extend_from_slice(&ciphertext);

  let encoded = base64::engine::general_purpose::STANDARD.encode(&combined);
  Ok(serde_json::json!({ "encrypted": encoded }))
}

async fn get_x_access_token(
  client: &reqwest::Client,
  sb_url: &str,
  sb_key: &str,
  user_id: &str,
) -> Result<(String, String), String> {
  let url = format!(
    "{sb_url}/rest/v1/connected_accounts?user_id=eq.{user_id}&channel=eq.x&status=eq.active&select=account_id,connection_params&limit=1"
  );
  let resp = client
    .get(&url)
    .header("apikey", sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .send()
    .await
    .map_err(|e| format!("X account lookup: {e}"))?;

  let rows: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();
  let row = rows.first().ok_or_else(|| "No active X account connected".to_string())?;

  let raw_params = row.get("connection_params").ok_or_else(|| "No connection_params".to_string())?;
  let params = decrypt_x_params(raw_params)?;
  let token = params.get("access_token").and_then(|v| v.as_str())
    .ok_or_else(|| "No X access_token stored".to_string())?;
  let account_id = row.get("account_id").and_then(|v| v.as_str()).unwrap_or("").to_string();

  Ok((token.to_string(), account_id))
}

async fn refresh_and_store_x_token(
  client: &reqwest::Client,
  sb_url: &str,
  sb_key: &str,
  user_id: &str,
) -> Result<(String, String), String> {
  let url = format!(
    "{sb_url}/rest/v1/connected_accounts?user_id=eq.{user_id}&channel=eq.x&status=eq.active&select=account_id,connection_params&limit=1"
  );
  let resp = client
    .get(&url)
    .header("apikey", sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .send()
    .await
    .map_err(|e| format!("X account lookup for refresh: {e}"))?;

  let rows: Vec<serde_json::Value> = resp.json().await.unwrap_or_default();
  let row = rows.first().ok_or_else(|| "No active X account for refresh".to_string())?;
  let raw_params = row.get("connection_params").ok_or_else(|| "No connection_params".to_string())?;
  let params = decrypt_x_params(raw_params)?;
  let refresh_token = params.get("refresh_token").and_then(|v| v.as_str())
    .ok_or_else(|| "No refresh_token stored".to_string())?;
  let account_id = row.get("account_id").and_then(|v| v.as_str()).unwrap_or("");

  let (client_id, client_secret) = x_config()?;

  let token_resp = client
    .post("https://api.twitter.com/2/oauth2/token")
    .basic_auth(&client_id, Some(&client_secret))
    .form(&[
      ("grant_type", "refresh_token"),
      ("refresh_token", refresh_token),
    ])
    .send()
    .await
    .map_err(|e| format!("X token refresh failed: {e}"))?;

  let status = token_resp.status();
  let token_body: serde_json::Value = token_resp.json().await.unwrap_or_default();

  if !status.is_success() {
    let update_url = format!(
      "{sb_url}/rest/v1/connected_accounts?user_id=eq.{user_id}&channel=eq.x&account_id=eq.{account_id}"
    );
    let _ = client
      .patch(&update_url)
      .header("apikey", sb_key)
      .header("Authorization", format!("Bearer {sb_key}"))
      .header("Content-Type", "application/json")
      .json(&serde_json::json!({
        "status": "credentials",
        "updated_at": chrono::Utc::now().to_rfc3339(),
      }))
      .send()
      .await;
    return Err(format!("X token refresh error {status}: {token_body}"));
  }

  let new_access = token_body.get("access_token").and_then(|v| v.as_str())
    .ok_or_else(|| "No access_token in refresh response".to_string())?;
  let new_refresh = token_body.get("refresh_token").and_then(|v| v.as_str())
    .unwrap_or(refresh_token);

  let mut new_params = params.clone();
  new_params["access_token"] = serde_json::Value::String(new_access.to_string());
  new_params["refresh_token"] = serde_json::Value::String(new_refresh.to_string());

  let store_params = match encrypt_x_params(&new_params) {
    Ok(p) => Some(p),
    Err(e) => {
      dev_log!("[x-refresh] encrypt failed, skipping token persist: {e}");
      None
    }
  };

  let update_url = format!(
    "{sb_url}/rest/v1/connected_accounts?user_id=eq.{user_id}&channel=eq.x&account_id=eq.{account_id}"
  );
  if let Some(store_params) = store_params.as_ref() {
    let _ = client
      .patch(&update_url)
      .header("apikey", sb_key)
      .header("Authorization", format!("Bearer {sb_key}"))
      .header("Content-Type", "application/json")
      .json(&serde_json::json!({
        "connection_params": store_params,
        "updated_at": chrono::Utc::now().to_rfc3339(),
      }))
      .send()
      .await;
  }

  Ok((new_access.to_string(), account_id.to_string()))
}

async fn x_authed_get(
  client: &reqwest::Client,
  url: &str,
  sb_url: &str,
  sb_key: &str,
  user_id: &str,
) -> Result<serde_json::Value, String> {
  let (token, _) = get_x_access_token(client, sb_url, sb_key, user_id).await?;

  let resp = client.get(url)
    .header("Authorization", format!("Bearer {token}"))
    .send().await.map_err(|e| format!("X API: {e}"))?;

  if resp.status().as_u16() == 401 {
    let (new_token, _) = refresh_and_store_x_token(client, sb_url, sb_key, user_id).await?;
    let retry = client.get(url)
      .header("Authorization", format!("Bearer {new_token}"))
      .send().await.map_err(|e| format!("X API retry: {e}"))?;
    if !retry.status().is_success() {
      let b = retry.text().await.unwrap_or_default();
      return Err(format!("X API error: {b}"));
    }
    return retry.json().await.map_err(|e| format!("X parse: {e}"));
  }
  if !resp.status().is_success() {
    let s = resp.status();
    let b = resp.text().await.unwrap_or_default();
    return Err(format!("X API error {s}: {b}"));
  }
  resp.json().await.map_err(|e| format!("X parse: {e}"))
}

async fn send_x_dm(
  client: &reqwest::Client,
  dm_conversation_id: &str,
  text: &str,
  user_id: &str,
  person_id: &str,
  _account_id: Option<&str>,
) -> Result<String, String> {
  let sb_url = std::env::var("VITE_SUPABASE_URL")
    .map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let sb_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let (access_token, _) = get_x_access_token(client, &sb_url, &sb_key, user_id).await?;

  let url = format!(
    "https://api.twitter.com/2/dm_conversations/{dm_conversation_id}/messages"
  );
  let payload = serde_json::json!({ "text": text });

  let resp = client.post(&url)
    .header("Authorization", format!("Bearer {access_token}"))
    .header("Content-Type", "application/json")
    .json(&payload)
    .send().await
    .map_err(|e| format!("X DM send failed: {e}"))?;

  let status = resp.status();

  if status.as_u16() == 401 {
    let (new_token, _) = refresh_and_store_x_token(client, &sb_url, &sb_key, user_id).await?;
    let retry = client.post(&url)
      .header("Authorization", format!("Bearer {new_token}"))
      .header("Content-Type", "application/json")
      .json(&payload)
      .send().await
      .map_err(|e| format!("X DM retry failed: {e}"))?;

    let s2 = retry.status();
    let b2: serde_json::Value = retry.json().await.unwrap_or_default();
    if !s2.is_success() {
      return Err(format!("X DM error {s2}: {b2}"));
    }
    let event_id = b2.get("data")
      .and_then(|d| d.get("dm_event_id"))
      .and_then(|v| v.as_str()).unwrap_or("");
    persist_outbound(
      client, user_id, person_id, "x", "dm", text,
      dm_conversation_id, event_id, &serde_json::json!([]), None,
    ).await.unwrap_or_else(|e| dev_log!("[send_x_dm] persist: {e}"));
    return Ok(event_id.to_string());
  }

  let body: serde_json::Value = resp.json().await.unwrap_or_default();
  if !status.is_success() {
    return Err(format!("X DM error {status}: {body}"));
  }

  let event_id = body.get("data")
    .and_then(|d| d.get("dm_event_id"))
    .and_then(|v| v.as_str()).unwrap_or("");
  persist_outbound(
    client, user_id, person_id, "x", "dm", text,
    dm_conversation_id, event_id, &serde_json::json!([]), None,
  ).await.unwrap_or_else(|e| dev_log!("[send_x_dm] persist: {e}"));

  Ok(event_id.to_string())
}

async fn backfill_x_dms(
  client: &reqwest::Client,
  user_id: &str,
  sb_url: &str,
  sb_key: &str,
) -> Result<(u32, u32), String> {
  let (_, my_x_id) = match get_x_access_token(client, sb_url, sb_key, user_id).await {
    Ok(t) => t,
    Err(_) => return Ok((0, 0)),
  };

  // Self-heal cursor with a 2h floor, same strategy as Unipile startup_sync.
  //
  // Previously this pulled up to 500 events every 2 minutes and upserted
  // them one-by-one, which meant the sync banner "Syncing X DMs…" was
  // effectively always on. X's `/2/dm_events` doesn't document a
  // `start_time` filter for its v2 endpoint, so we paginate and terminate
  // client-side once we cross the cursor. Events are returned in reverse
  // chronological order (X docs), so a page entirely older than the cursor
  // means we're done.
  let x_cursor_resp = client
    .get(format!(
      "{sb_url}/rest/v1/messages?user_id=eq.{user_id}&channel=eq.x&select=sent_at&order=sent_at.desc&limit=1"
    ))
    .header("apikey", sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .send().await;
  let max_sent_at: Option<chrono::DateTime<chrono::Utc>> = match x_cursor_resp {
    Ok(r) if r.status().is_success() => {
      let rows: Vec<serde_json::Value> = r.json().await.unwrap_or_default();
      rows.first()
        .and_then(|r| r.get("sent_at").and_then(|v| v.as_str()))
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc))
    }
    _ => None,
  };
  let self_heal_floor = chrono::Utc::now() - chrono::Duration::hours(SYNC_SELF_HEAL_HOURS);
  let cursor: Option<chrono::DateTime<chrono::Utc>> = max_sent_at.map(|t| std::cmp::min(t, self_heal_floor));

  let base_dm_url = "https://api.twitter.com/2/dm_events?dm_event.fields=id,text,event_type,dm_conversation_id,created_at,sender_id&event_types=MessageCreate&max_results=100";

  let mut events: Vec<serde_json::Value> = Vec::new();
  let mut next_url = base_dm_url.to_string();
  const X_DM_MAX_PAGES: usize = 50;
  let mut pages_seen = 0usize;

  loop {
    if pages_seen >= X_DM_MAX_PAGES {
      return Err(format!("X DM pagination exceeded {X_DM_MAX_PAGES} pages before reaching cursor"));
    }
    pages_seen += 1;

    let dm_body = x_authed_get(client, &next_url, sb_url, sb_key, user_id).await?;
    let page: Vec<serde_json::Value> = dm_body.get("data")
      .and_then(|v| v.as_array())
      .cloned()
      .unwrap_or_default();

    let mut saw_older_than_cursor = false;
    if let Some(cut) = cursor {
      for ev in &page {
        let ts = ev.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
        let older = chrono::DateTime::parse_from_rfc3339(ts).ok()
          .map(|dt| dt.with_timezone(&chrono::Utc) < cut)
          .unwrap_or(false);
        if older { saw_older_than_cursor = true; }
        else { events.push(ev.clone()); }
      }
    } else {
      events.extend(page.iter().cloned());
    }

    if saw_older_than_cursor { break; }

    match dm_body.get("meta").and_then(|m| m.get("next_token")).and_then(|v| v.as_str()) {
      Some(token) => {
        next_url = format!("{base_dm_url}&pagination_token={token}");
      }
      None => break,
    }
  }

  if events.is_empty() {
    return Ok((0, 0));
  }

  let mut convos: std::collections::HashMap<String, Vec<serde_json::Value>> =
    std::collections::HashMap::new();
  for event in &events {
    let convo_id = event.get("dm_conversation_id")
      .and_then(|v| v.as_str()).unwrap_or("");
    if !convo_id.is_empty() {
      convos.entry(convo_id.to_string()).or_default().push(event.clone());
    }
  }

  let mut other_user_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
  let mut convo_other: std::collections::HashMap<String, String> = std::collections::HashMap::new();

  for (convo_id, msgs) in &convos {
    let mut other_id = String::new();
    for msg in msgs {
      let sender = msg.get("sender_id").and_then(|v| v.as_str()).unwrap_or("");
      if !sender.is_empty() && sender != my_x_id {
        other_id = sender.to_string();
        other_user_ids.insert(sender.to_string());
        break;
      }
    }
    if other_id.is_empty() {
      let parts: Vec<&str> = convo_id.split('-').collect();
      if parts.len() == 2 {
        let cand = if parts[0] == my_x_id { parts[1] } else { parts[0] };
        if !cand.is_empty() && cand != my_x_id {
          other_id = cand.to_string();
          other_user_ids.insert(cand.to_string());
        }
      }
    }
    if !other_id.is_empty() {
      convo_other.insert(convo_id.clone(), other_id);
    }
  }

  let user_ids_vec: Vec<&str> = other_user_ids.iter().map(|s| s.as_str()).collect();
  let user_info: std::collections::HashMap<String, serde_json::Value> = if !user_ids_vec.is_empty() {
    let ids_param = user_ids_vec.join(",");
    let users_url = format!(
      "https://api.twitter.com/2/users?ids={ids_param}&user.fields=name,username,profile_image_url"
    );
    match x_authed_get(client, &users_url, sb_url, sb_key, user_id).await {
      Ok(body) => body.get("data").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|u| {
          let id = u.get("id").and_then(|v| v.as_str())?;
          Some((id.to_string(), u.clone()))
        }).collect()
      }).unwrap_or_default(),
      Err(_) => std::collections::HashMap::new(),
    }
  } else {
    std::collections::HashMap::new()
  };

  let mut total_msgs = 0u32;
  let convo_count = convos.len() as u32;
  let mut errors: Vec<String> = Vec::new();

  for (convo_id, msgs) in &convos {
    let other_id = match convo_other.get(convo_id) {
      Some(id) => id,
      None => continue,
    };

    let user = user_info.get(other_id);
    let display_name = user
      .and_then(|u| u.get("name").and_then(|v| v.as_str()))
      .unwrap_or(other_id);
    let username = user
      .and_then(|u| u.get("username").and_then(|v| v.as_str()))
      .unwrap_or("");
    let handle = if !username.is_empty() { username.to_lowercase() } else { other_id.clone() };

    let earliest_sender = msgs.iter()
      .min_by_key(|m| m.get("created_at").and_then(|v| v.as_str()).unwrap_or(""))
      .and_then(|m| m.get("sender_id").and_then(|v| v.as_str()))
      .unwrap_or("");
    let direction = if earliest_sender == my_x_id { "outbound" } else { "inbound" };

    let mut x_metadata = serde_json::Map::new();
    x_metadata.insert("x_user_id".to_string(), serde_json::Value::String(other_id.clone()));
    if !username.is_empty() {
      x_metadata.insert("username".to_string(), serde_json::Value::String(username.to_lowercase()));
    }

    let person_url = format!("{sb_url}/rest/v1/rpc/backfill_find_or_create_person");
    let person_resp = client
      .post(&person_url)
      .header("apikey", sb_key)
      .header("Authorization", format!("Bearer {sb_key}"))
      .header("Content-Type", "application/json")
      .header("Accept", "application/vnd.pgrst.object+json")
      .json(&serde_json::json!({
        "p_user_id": user_id,
        "p_channel": "x",
        "p_handle": handle,
        "p_display_name": display_name,
        "p_unipile_account_id": my_x_id,
        "p_direction": direction,
        "p_metadata": serde_json::Value::Object(x_metadata)
      }))
      .send()
      .await;

    let person_id = match person_resp {
      Ok(r) if r.status().is_success() => {
        let b: serde_json::Value = r.json().await.unwrap_or_default();
        let pid = b.get("person_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if pid.is_empty() { continue; }
        pid
      }
      _ => continue,
    };

    let avatar_url = user
      .and_then(|u| u.get("profile_image_url").and_then(|v| v.as_str()));
    if let Some(url) = avatar_url {
      let _ = client
        .patch(format!("{sb_url}/rest/v1/persons?id=eq.{person_id}"))
        .header("apikey", sb_key)
        .header("Authorization", format!("Bearer {sb_key}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "avatar_url": url }))
        .send()
        .await;
    }

    let mut rows_to_upsert: Vec<serde_json::Value> = Vec::with_capacity(msgs.len());
    for msg in msgs {
      let external_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
      if external_id.is_empty() { continue; }

      let sender_id = msg.get("sender_id").and_then(|v| v.as_str()).unwrap_or("");
      let direction = if sender_id == my_x_id { "outbound" } else { "inbound" };
      let text = msg.get("text").and_then(|v| v.as_str());
      let created_at = msg.get("created_at").and_then(|v| v.as_str()).unwrap_or("");

      // PGRST102 requires identical keys across every row in a bulk upsert.
      let read_at_val = if direction == "inbound" {
        serde_json::Value::String(chrono::Utc::now().to_rfc3339())
      } else {
        serde_json::Value::Null
      };

      let row = serde_json::json!({
        "user_id": user_id,
        "person_id": person_id,
        "external_id": external_id,
        "channel": "x",
        "direction": direction,
        "message_type": "dm",
        "body_text": text,
        "attachments": [],
        "thread_id": convo_id,
        "sent_at": created_at,
        "triage": "unclassified",
        "read_at": read_at_val,
      });
      rows_to_upsert.push(row);
    }

    match supabase_upsert_batch(
      client,
      sb_url,
      sb_key,
      "messages",
      "user_id,external_id",
      "resolution=ignore-duplicates,return=minimal",
      &rows_to_upsert,
      "backfill_x_dms",
    ).await {
      Ok(n) => total_msgs += n as u32,
      Err(e) => errors.push(e),
    }
  }

  if !errors.is_empty() {
    return Err(errors.join("; "));
  }

  Ok((total_msgs, convo_count))
}

// ─── iMESSAGE / SMS INTEGRATION ──────────────────────────────────────────────

fn imessage_db_path() -> Result<String, String> {
  let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
  let path = format!("{home}/Library/Messages/chat.db");
  if !std::path::Path::new(&path).exists() {
    return Err("Messages database not found. Make sure you're on macOS with Messages configured.".to_string());
  }
  Ok(path)
}

fn open_imessage_db(db_path: &str) -> Result<rusqlite::Connection, String> {
  rusqlite::Connection::open_with_flags(
    db_path,
    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
  ).map_err(|e| {
    let msg = e.to_string();
    if msg.contains("unable to open") || msg.contains("authorization") || msg.contains("permission") {
      "Cannot access Messages database. Grant Full Disk Access to Convolios in System Settings > Privacy & Security > Full Disk Access.".to_string()
    } else {
      format!("Messages database error: {e}")
    }
  })
}

fn apple_date_to_rfc3339(date: i64) -> String {
  let unix_secs = if date > 1_000_000_000_000_000 {
    (date / 1_000_000_000) + 978307200
  } else if date > 1_000_000_000 {
    date + 978307200
  } else {
    return String::new();
  };
  chrono::DateTime::from_timestamp(unix_secs, 0)
    .map(|dt| dt.to_rfc3339())
    .unwrap_or_default()
}

/// Extract plain text from an `attributedBody` typedstream blob.
///
/// macOS Messages stores message text as an `NSAttributedString` archived via
/// Apple's typedstream format ("NeXT/Apple typedstream data, little endian,
/// version 4, system 1000"). The plain-text payload sits after the `NSString`
/// class definition, prefixed by a `+` (0x2b) marker and a length-encoded
/// byte sequence. Modern macOS often leaves `message.text` NULL and only
/// populates this blob.
///
/// Length encoding after the `0x2b` marker (little-endian per the stream
/// signature):
/// - byte `n < 0x80` — direct 1-byte length
/// - `0x81` then 1 byte — length ≤ 255
/// - `0x82` then 2 bytes (LE) — length ≤ 65535
/// - `0x83` then 3 bytes (LE) — length ≤ 16_777_215
fn decode_attributed_body(blob: &[u8]) -> Option<String> {
  let ns_str = b"NSString";
  let start = blob.windows(ns_str.len()).position(|w| w == ns_str)?;
  let search = &blob[start + ns_str.len()..];

  let marker_rel = search.iter().position(|&b| b == 0x2b)?;
  let after_marker = marker_rel + 1;
  if after_marker >= search.len() { return None; }

  let (length, data_start) = match search[after_marker] {
    n if n < 0x80 => (n as usize, after_marker + 1),
    0x81 if after_marker + 1 < search.len() => {
      (search[after_marker + 1] as usize, after_marker + 2)
    }
    0x82 if after_marker + 2 < search.len() => {
      let len = u16::from_le_bytes([search[after_marker + 1], search[after_marker + 2]]) as usize;
      (len, after_marker + 3)
    }
    0x83 if after_marker + 3 < search.len() => {
      let len = (search[after_marker + 1] as usize)
        | ((search[after_marker + 2] as usize) << 8)
        | ((search[after_marker + 3] as usize) << 16);
      (len, after_marker + 4)
    }
    _ => return None,
  };

  let end = data_start.checked_add(length)?;
  if end > search.len() { return None; }
  String::from_utf8(search[data_start..end].to_vec()).ok()
}

#[derive(Debug)]
struct IMsg {
  guid: String,
  text: String,
  date: i64,
  is_from_me: bool,
  _service: String,
  sender_handle: String,
  chat_guid: String,
  group_name: Option<String>,
  chat_identifier: String,
}

/// Cheap watermark read: `message.ROWID` is the primary key, so `MAX` is a
/// single B-tree lookup. Used by `spawn_imessage_watcher` to skip an entire
/// poll cycle (SQLite scan + Supabase round-trip) when `chat.db` has not
/// advanced since the last tick. Returns `0` for an empty table — callers
/// should compare against their stored watermark, not rely on absence.
fn imessage_max_rowid(db_path: &str) -> Result<i64, String> {
  let conn = open_imessage_db(db_path)?;
  let max: Option<i64> = conn
    .query_row("SELECT MAX(ROWID) FROM message", [], |r| r.get(0))
    .map_err(|e| format!("SQL query: {e}"))?;
  Ok(max.unwrap_or(0))
}

fn read_imessage_db(db_path: &str, limit: u32) -> Result<Vec<IMsg>, String> {
  let conn = open_imessage_db(db_path)?;

  let mut stmt = conn.prepare(
    "SELECT m.guid, m.text, m.date, m.is_from_me, m.service,
            COALESCE(h.id, '') as sender_handle,
            c.guid as chat_guid, c.display_name, c.chat_identifier,
            m.attributedBody
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
     JOIN chat c ON c.ROWID = cmj.chat_id
     LEFT JOIN handle h ON h.ROWID = m.handle_id
     WHERE m.associated_message_type = 0
       AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
     ORDER BY m.date DESC
     LIMIT ?1"
  ).map_err(|e| format!("SQL prepare: {e}"))?;

  let rows = stmt.query_map([limit], |row| {
    let text_col: Option<String> = row.get(1)?;
    let ab_blob: Option<Vec<u8>> = row.get(9)?;
    let text = text_col
      .filter(|t| !t.is_empty())
      .or_else(|| ab_blob.as_deref().and_then(decode_attributed_body))
      .unwrap_or_default();

    Ok(IMsg {
      guid: row.get(0)?,
      text,
      date: row.get(2)?,
      is_from_me: row.get::<_, i32>(3)? != 0,
      _service: row.get::<_, String>(4).unwrap_or_default(),
      sender_handle: row.get::<_, String>(5).unwrap_or_default(),
      chat_guid: row.get::<_, String>(6).unwrap_or_default(),
      group_name: row.get::<_, Option<String>>(7).unwrap_or(None),
      chat_identifier: row.get::<_, String>(8).unwrap_or_default(),
    })
  }).map_err(|e| format!("SQL query: {e}"))?;

  let mut messages = Vec::new();
  for row in rows {
    if let Ok(msg) = row {
      if !msg.text.is_empty() { messages.push(msg); }
    }
  }
  Ok(messages)
}

#[tauri::command]
async fn connect_imessage(
  user_id: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let db_path = imessage_db_path()?;

  let (handle_count, msg_count) = {
    let conn = open_imessage_db(&db_path)?;
    let handles: i64 = conn.query_row("SELECT COUNT(*) FROM handle", [], |r| r.get(0)).unwrap_or(0);
    let msgs: i64 = conn.query_row("SELECT COUNT(*) FROM message WHERE associated_message_type = 0 AND (text IS NOT NULL OR attributedBody IS NOT NULL)", [], |r| r.get(0)).unwrap_or(0);
    (handles, msgs)
  };

  let sb_url = std::env::var("VITE_SUPABASE_URL")
    .map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let sb_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let now = chrono::Utc::now().to_rfc3339();
  let account_row = serde_json::json!({
    "user_id": user_id,
    "provider": "imessage",
    "channel": "imessage",
    "account_id": "local-imessage",
    "status": "active",
    "display_name": "Messages",
    "provider_type": "iMessage",
    "connection_params": {
      "db_path": "~/Library/Messages/chat.db",
      "handle_count": handle_count,
      "message_count": msg_count,
    },
    "last_synced_at": now,
    "updated_at": now,
  });

  let store_resp = state.http
    .post(format!("{sb_url}/rest/v1/connected_accounts?on_conflict=user_id,provider,account_id"))
    .header("apikey", &sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .header("Content-Type", "application/json")
    .header("Prefer", "resolution=merge-duplicates")
    .json(&account_row)
    .send().await
    .map_err(|e| format!("Failed to store account: {e}"))?;

  if !store_resp.status().is_success() && store_resp.status().as_u16() != 409 {
    let b = store_resp.text().await.unwrap_or_default();
    return Err(format!("Failed to save account: {b}"));
  }

  Ok(format!("Connected! Found {handle_count} contacts and {msg_count} messages."))
}

// Lightweight read-only stats on the local chat.db. Called by the Settings UI
// whenever the page renders so the iMessage card reflects *current* state,
// not whatever `connect_imessage` persisted into connection_params last time.
// Returns null-ish zeros if the DB is missing or unreadable, so the UI can
// still render (and the full connect flow will surface a clearer error).
#[tauri::command]
async fn imessage_status() -> Result<serde_json::Value, String> {
  let db_path = match imessage_db_path() {
    Ok(p) => p,
    Err(_) => {
      return Ok(serde_json::json!({
        "handle_count": 0,
        "message_count": 0,
        "oldest_message_at": serde_json::Value::Null,
        "newest_message_at": serde_json::Value::Null,
        "accessible": false,
      }));
    }
  };
  let conn = match open_imessage_db(&db_path) {
    Ok(c) => c,
    Err(_) => {
      return Ok(serde_json::json!({
        "handle_count": 0,
        "message_count": 0,
        "oldest_message_at": serde_json::Value::Null,
        "newest_message_at": serde_json::Value::Null,
        "accessible": false,
      }));
    }
  };
  let handle_count: i64 = conn
    .query_row("SELECT COUNT(*) FROM handle", [], |r| r.get(0))
    .unwrap_or(0);
  let message_count: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM message WHERE associated_message_type = 0 AND (text IS NOT NULL OR attributedBody IS NOT NULL)",
      [],
      |r| r.get(0),
    )
    .unwrap_or(0);
  let oldest: Option<i64> = conn
    .query_row(
      "SELECT MIN(date) FROM message WHERE associated_message_type = 0 AND (text IS NOT NULL OR attributedBody IS NOT NULL)",
      [],
      |r| r.get(0),
    )
    .ok();
  let newest: Option<i64> = conn
    .query_row(
      "SELECT MAX(date) FROM message WHERE associated_message_type = 0 AND (text IS NOT NULL OR attributedBody IS NOT NULL)",
      [],
      |r| r.get(0),
    )
    .ok();

  let oldest_iso = oldest.map(apple_date_to_rfc3339).filter(|s| !s.is_empty());
  let newest_iso = newest.map(apple_date_to_rfc3339).filter(|s| !s.is_empty());

  Ok(serde_json::json!({
    "handle_count": handle_count,
    "message_count": message_count,
    "oldest_message_at": oldest_iso,
    "newest_message_at": newest_iso,
    "accessible": true,
  }))
}

async fn backfill_imessage(
  client: &reqwest::Client,
  user_id: &str,
  sb_url: &str,
  sb_key: &str,
) -> Result<(u32, u32), String> {
  let acct_url = format!(
    "{sb_url}/rest/v1/connected_accounts?user_id=eq.{user_id}&channel=eq.imessage&status=eq.active&select=account_id&limit=1"
  );
  let acct_resp = client.get(&acct_url)
    .header("apikey", sb_key)
    .header("Authorization", format!("Bearer {sb_key}"))
    .send().await.map_err(|e| format!("iMessage account lookup: {e}"))?;
  let rows: Vec<serde_json::Value> = acct_resp.json().await.unwrap_or_default();
  if rows.is_empty() { return Ok((0, 0)); }

  let db_path = imessage_db_path()?;
  let messages = read_imessage_db(&db_path, 2000)
    .map_err(|e| format!("iMessage read: {e}"))?;

  if messages.is_empty() { return Ok((0, 0)); }

  let mut convos: std::collections::HashMap<String, Vec<&IMsg>> =
    std::collections::HashMap::new();
  for msg in &messages {
    if !msg.chat_guid.is_empty() {
      convos.entry(msg.chat_guid.clone()).or_default().push(msg);
    }
  }

  let mut total_msgs = 0u32;
  let convo_count = convos.len() as u32;
  let mut errors: Vec<String> = Vec::new();

  for (chat_guid, msgs) in &convos {
    let first = msgs.first().unwrap();
    let is_group = first.group_name.is_some()
      || chat_guid.contains(";+;");

    let handle = if is_group {
      chat_guid.clone()
    } else {
      let raw = if !first.chat_identifier.is_empty() {
        first.chat_identifier.clone()
      } else {
        msgs.iter()
          .find(|m| !m.is_from_me && !m.sender_handle.is_empty())
          .map(|m| m.sender_handle.clone())
          .unwrap_or_else(|| chat_guid.clone())
      };
      normalize_handle(&raw, "imessage")
    };

    let display_name = if is_group {
      first.group_name.clone()
        .unwrap_or_else(|| format!("Group ({})", handle))
    } else {
      handle.clone()
    };

    let message_type = if is_group { "group" } else { "dm" };

    let earliest = msgs.iter().min_by_key(|m| m.date);
    let direction = match earliest {
      Some(m) if m.is_from_me => "outbound",
      _ => "inbound",
    };

    let person_url = format!("{sb_url}/rest/v1/rpc/backfill_find_or_create_person");
    let person_resp = client
      .post(&person_url)
      .header("apikey", sb_key)
      .header("Authorization", format!("Bearer {sb_key}"))
      .header("Content-Type", "application/json")
      .header("Accept", "application/vnd.pgrst.object+json")
      .json(&serde_json::json!({
        "p_user_id": user_id,
        "p_channel": "imessage",
        "p_handle": handle,
        "p_display_name": display_name,
        "p_unipile_account_id": "local-imessage",
        "p_direction": direction
      }))
      .send().await;

    let person_id = match person_resp {
      Ok(r) if r.status().is_success() => {
        let b: serde_json::Value = r.json().await.unwrap_or_default();
        let pid = b.get("person_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if pid.is_empty() {
          errors.push(format!("iMessage person RPC returned empty person_id for {chat_guid}"));
          continue;
        }
        pid
      }
      Ok(r) => {
        let status = r.status();
        let body = r.text().await.unwrap_or_default();
        errors.push(format!("iMessage person RPC {status} for {chat_guid}: {body}"));
        continue;
      }
      Err(e) => {
        errors.push(format!("iMessage person RPC error for {chat_guid}: {e}"));
        continue;
      }
    };

    let mut rows_to_upsert: Vec<serde_json::Value> = Vec::with_capacity(msgs.len());
    for msg in msgs {
      if msg.guid.is_empty() { continue; }
      let sent_at = apple_date_to_rfc3339(msg.date);
      if sent_at.is_empty() { continue; }

      let direction = if msg.is_from_me { "outbound" } else { "inbound" };
      let sender_name = if msg.is_from_me { None } else {
        Some(if !msg.sender_handle.is_empty() {
          msg.sender_handle.as_str()
        } else { "" })
      };

      // PGRST102 requires identical keys across every row in a bulk upsert.
      let read_at_val = if direction == "inbound" {
        serde_json::Value::String(chrono::Utc::now().to_rfc3339())
      } else {
        serde_json::Value::Null
      };

      let row = serde_json::json!({
        "user_id": user_id,
        "person_id": person_id,
        "external_id": format!("imsg-{}", msg.guid),
        "channel": "imessage",
        "direction": direction,
        "message_type": message_type,
        "body_text": msg.text,
        "attachments": [],
        "thread_id": chat_guid,
        "sender_name": sender_name,
        "sent_at": sent_at,
        "triage": "unclassified",
        "read_at": read_at_val,
      });
      rows_to_upsert.push(row);
    }

    match supabase_upsert_batch(
      client,
      sb_url,
      sb_key,
      "messages",
      "user_id,external_id",
      "resolution=ignore-duplicates,return=minimal",
      &rows_to_upsert,
      "backfill_imessage",
    ).await {
      Ok(n) => total_msgs += n as u32,
      Err(e) => errors.push(e),
    }
  }

  if !errors.is_empty() {
    return Err(errors.join("; "));
  }

  Ok((total_msgs, convo_count))
}

async fn send_imessage_dm(
  client: &reqwest::Client,
  chat_id: &str,
  text: &str,
  user_id: &str,
  person_id: &str,
) -> Result<String, String> {
  let parts: Vec<&str> = chat_id.splitn(3, ';').collect();
  let service = parts.first().copied().unwrap_or("iMessage");
  let handle = parts.get(2).copied().unwrap_or(chat_id);

  if handle.is_empty() {
    return Err("Cannot determine recipient handle".to_string());
  }

  let script = format!(
    "on run argv\n\
       tell application \"Messages\" to send (item 1 of argv) to buddy (item 2 of argv) \
       of (1st account whose service type = {service})\n\
     end run"
  );

  let output = std::process::Command::new("osascript")
    .args(["-e", &script, text, handle])
    .output()
    .map_err(|e| format!("AppleScript failed: {e}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(format!("Messages send failed: {stderr}"));
  }

  let event_id = format!("imsg-sent-{}", chrono::Utc::now().timestamp_millis());
  persist_outbound(
    client, user_id, person_id, "imessage", "dm", text,
    chat_id, &event_id, &serde_json::json!([]), None,
  ).await.unwrap_or_else(|e| dev_log!("[send_imessage] persist: {e}"));

  Ok(event_id.to_string())
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

  let window_start = (now - chrono::Duration::seconds(10)).to_rfc3339();
  let window_end = (now + chrono::Duration::seconds(10)).to_rfc3339();
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
      ("sent_at", &format!("lte.{window_end}") as &str),
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
    format!("{supabase_url}/rest/v1/messages?on_conflict=user_id,external_id")
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
async fn fetch_attachment(message_id: String, attachment_id: String, channel: Option<String>, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
  let cache_dir = app.path().app_cache_dir().map_err(|e| format!("Cache dir error: {e}"))?
    .join("attachments");
  let cache_key = format!("{message_id}_{attachment_id}");
  let cache_file = cache_dir.join(&cache_key);
  let meta_file = cache_dir.join(format!("{cache_key}.meta"));

  if cache_file.exists() && meta_file.exists() {
    if let (Ok(bytes), Ok(ct)) = (std::fs::read(&cache_file), std::fs::read_to_string(&meta_file)) {
      let b64 = base64_encode(&bytes);
      return Ok(format!("data:{ct};base64,{b64}"));
    }
  }

  let (api_key, base) = unipile_config()?;
  let is_email = channel.as_deref().map(|c| c == "email").unwrap_or(false);
  let url = if is_email {
    format!("{base}/api/v1/emails/{message_id}/attachments/{attachment_id}")
  } else {
    format!("{base}/api/v1/messages/{message_id}/attachments/{attachment_id}")
  };

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

  if let Some(len) = response.content_length() {
    if len > MAX_ATTACHMENT_DOWNLOAD_BYTES {
      return Err(format!(
        "Attachment is {:.1}MB — exceeds {}MB limit",
        len as f64 / (1024.0 * 1024.0),
        MAX_ATTACHMENT_DOWNLOAD_BYTES / (1024 * 1024)
      ));
    }
  }

  let bytes = response.bytes().await.map_err(|e| format!("Read error: {e}"))?;

  if bytes.len() as u64 > MAX_ATTACHMENT_DOWNLOAD_BYTES {
    return Err(format!(
      "Attachment is {:.1}MB — exceeds {}MB limit",
      bytes.len() as f64 / (1024.0 * 1024.0),
      MAX_ATTACHMENT_DOWNLOAD_BYTES / (1024 * 1024)
    ));
  }

  if bytes.is_empty() {
    return Ok(String::new());
  }

  if let Err(e) = std::fs::create_dir_all(&cache_dir) {
    dev_log!("[attachment-cache] Failed to create cache dir: {e}");
  } else {
    let _ = std::fs::write(&cache_file, &bytes);
    let _ = std::fs::write(&meta_file, &content_type);
  }

  let b64 = base64_encode(&bytes);
  Ok(format!("data:{content_type};base64,{b64}"))
}

const MAX_ATTACHMENT_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

#[tauri::command]
async fn open_attachment(message_id: String, attachment_id: String, channel: Option<String>, filename: Option<String>, app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  let cache_dir = app.path().app_cache_dir().map_err(|e| format!("Cache dir error: {e}"))?
    .join("attachments");
  let cache_key = format!("{message_id}_{attachment_id}");
  let cache_file = cache_dir.join(&cache_key);
  let meta_file = cache_dir.join(format!("{cache_key}.meta"));

  let bytes = if cache_file.exists() && meta_file.exists() {
    std::fs::read(&cache_file).map_err(|e| format!("Read cache: {e}"))?
  } else {
    let (api_key, base) = unipile_config()?;
    let is_email = channel.as_deref().map(|c| c == "email").unwrap_or(false);
    let url = if is_email {
      format!("{base}/api/v1/emails/{message_id}/attachments/{attachment_id}")
    } else {
      format!("{base}/api/v1/messages/{message_id}/attachments/{attachment_id}")
    };

    let response = state.http
      .get(&url)
      .header("X-API-KEY", &api_key)
      .send()
      .await
      .map_err(|e| format!("Attachment fetch failed: {e}"))?;

    if !response.status().is_success() {
      return Err("Attachment not found".to_string());
    }

    if let Some(len) = response.content_length() {
      if len > MAX_ATTACHMENT_DOWNLOAD_BYTES {
        return Err(format!(
          "Attachment is {:.1}MB — exceeds {}MB limit",
          len as f64 / (1024.0 * 1024.0),
          MAX_ATTACHMENT_DOWNLOAD_BYTES / (1024 * 1024)
        ));
      }
    }

    let content_type = response.headers().get("content-type")
      .and_then(|v| v.to_str().ok())
      .unwrap_or("application/octet-stream")
      .to_string();

    let data = response.bytes().await.map_err(|e| format!("Read error: {e}"))?.to_vec();
    if data.len() as u64 > MAX_ATTACHMENT_DOWNLOAD_BYTES {
      return Err(format!(
        "Attachment is {:.1}MB — exceeds {}MB limit",
        data.len() as f64 / (1024.0 * 1024.0),
        MAX_ATTACHMENT_DOWNLOAD_BYTES / (1024 * 1024)
      ));
    }
    if data.is_empty() {
      return Err("Empty attachment".to_string());
    }

    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::write(&cache_file, &data);
    let _ = std::fs::write(&meta_file, &content_type);
    data
  };

  let tmp_dir = std::env::temp_dir().join("convolios-attachments");
  std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Temp dir: {e}"))?;
  let raw_name = filename.unwrap_or_else(|| format!("{attachment_id}"));
  let file_name = Path::new(&raw_name).file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| format!("{attachment_id}"));
  let tmp_path = tmp_dir.join(&file_name);
  std::fs::write(&tmp_path, &bytes).map_err(|e| format!("Write temp: {e}"))?;

  open::that(&tmp_path).map_err(|e| format!("Open failed: {e}"))?;
  Ok(())
}

#[tauri::command]
async fn fetch_chat_avatars(
  chat_id: String,
  user_id: String,
  state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;
  let user_scope = urlencoding::encode(&user_id);

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

    let att_provider_id = att.get("provider_id").and_then(|v| v.as_str()).unwrap_or("");
    let att_pub_id = att.get("public_identifier").and_then(|v| v.as_str()).unwrap_or("");

    let mut person_data: Option<serde_json::Value> = None;

    if !att_provider_id.is_empty() || !att_pub_id.is_empty() {
      let handle_to_find = if !att_pub_id.is_empty() { att_pub_id } else { att_provider_id };
      let identity_url = format!(
        "{supabase_url}/rest/v1/identities?handle=eq.{}&user_id=eq.{user_scope}&select=person_id",
        urlencoding::encode(handle_to_find)
      );
      if let Some(pid) = client.get(&identity_url)
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .send().await.ok()
        .and_then(|r| if r.status().is_success() { Some(r) } else { None })
      {
        if let Ok(arr) = pid.json::<serde_json::Value>().await {
          if let Some(pid_str) = arr.as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.get("person_id"))
            .and_then(|v| v.as_str())
          {
            let purl = format!(
              "{supabase_url}/rest/v1/persons?id=eq.{pid_str}&user_id=eq.{user_scope}&select=id,avatar_url,avatar_stale"
            );
            if let Some(pr) = client.get(&purl)
              .header("apikey", &service_key)
              .header("Authorization", format!("Bearer {service_key}"))
              .send().await.ok()
              .and_then(|r| if r.status().is_success() { Some(r) } else { None })
            {
              person_data = pr.json::<serde_json::Value>().await.ok()
                .and_then(|arr| arr.as_array()?.first().cloned());
            }
          }
        }
      }
    }

    if person_data.is_none() {
      let person_url = format!(
        "{supabase_url}/rest/v1/persons?display_name=eq.{}&user_id=eq.{user_scope}&select=id,avatar_url,avatar_stale",
        urlencoding::encode(&att_name)
      );
      if let Some(r) = client.get(&person_url)
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .send().await.ok()
        .and_then(|r| if r.status().is_success() { Some(r) } else { None })
      {
        person_data = r.json::<serde_json::Value>().await.ok()
          .and_then(|arr| arr.as_array()?.first().cloned());
      }
    }

    if let Some(person) = person_data {
      let pid = person.get("id").and_then(|v| v.as_str()).unwrap_or("");
      if pid.is_empty() { continue; }

      let existing_url = person.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("");
      let stale = person.get("avatar_stale").and_then(|v| v.as_bool()).unwrap_or(true);

      if !existing_url.is_empty() && !stale {
        result.insert(att_name, existing_url.to_string());
      } else {
        let pic_url = att.get("picture_url").and_then(|v| v.as_str());
        if let Some(url) = upload_avatar(
          client, &api_key, &base, &supabase_url, &service_key,
          pid, att_id, pic_url,
        ).await {
          result.insert(att_name, url);
        }
      }
    }
  }

  Ok(result)
}

/// Full reconciliation: fetch ALL chats from Unipile (no time filter),
/// diff against local identities, purge persons whose chats no longer exist.
/// Heavy operation — run in background, not during startup.
#[tauri::command]
async fn reconcile_chats(
  user_id: String,
  state: State<'_, AppState>,
) -> Result<String, String> {
  let (api_key, base) = unipile_config()?;
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;
  let client = &state.http;

  let accounts_resp = client
    .get(format!(
      "{supabase_url}/rest/v1/connected_accounts?user_id=eq.{user_id}&select=account_id"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send().await
    .map_err(|e| format!("accounts fetch: {e}"))?;

  let accounts: Vec<serde_json::Value> = if accounts_resp.status().is_success() {
    accounts_resp.json().await.unwrap_or_default()
  } else {
    return Ok("No accounts".to_string());
  };

  let mut purged = 0u32;
  let mut purged_persons = std::collections::HashSet::new();

  for acc in &accounts {
    let account_id = acc.get("account_id").and_then(|v| v.as_str()).unwrap_or("");
    if account_id.is_empty() { continue; }

    let chats_url = format!("{base}/api/v1/chats?account_id={account_id}&limit=50");
    let remote_chats = match fetch_paginated(client, &chats_url, &api_key, 100, Some(state.inner()), Some(account_id)).await {
      Ok(c) => c,
      Err(e) => {
        err_log!("[reconcile_unipile] chats fetch failed for {account_id}: {e}");
        continue;
      }
    };

    let remote_chat_ids: std::collections::HashSet<String> = remote_chats.iter()
      .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
      .collect();

    if remote_chat_ids.is_empty() {
      dev_log!("[reconcile] Skipping account {account_id}: Unipile returned 0 chats (API issue or empty account)");
      continue;
    }

    // Collect all distinct local chat_provider_ids for this account (paginated)
    let mut local_chat_ids = std::collections::HashSet::new();
    let mut offset = 0usize;
    loop {
      let end = offset + 999;
      let msgs_resp = client
        .get(format!(
          "{supabase_url}/rest/v1/messages?user_id=eq.{user_id}&unipile_account_id=eq.{account_id}&select=chat_provider_id"
        ))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Range", format!("{offset}-{end}"))
        .send().await;

      let page: Vec<serde_json::Value> = match msgs_resp {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 206 => {
          r.json().await.unwrap_or_default()
        }
        _ => break,
      };

      let count = page.len();
      for m in &page {
        if let Some(cid) = m.get("chat_provider_id").and_then(|v| v.as_str()) {
          local_chat_ids.insert(cid.to_string());
        }
      }

      if count < 1000 { break; }
      offset += 1000;
    }

    for chat_id in &local_chat_ids {
      if remote_chat_ids.contains(chat_id) { continue; }

      // Find the specific person(s) who have messages in this deleted chat
      let person_resp = client
        .get(format!(
          "{supabase_url}/rest/v1/messages?user_id=eq.{user_id}&chat_provider_id=eq.{chat_id}&select=person_id&limit=1"
        ))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .send().await;

      let affected_pid: Option<String> = match person_resp {
        Ok(r) if r.status().is_success() => {
          let rows: Vec<serde_json::Value> = r.json().await.unwrap_or_default();
          rows.first()
            .and_then(|r| r.get("person_id").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
        }
        _ => None,
      };

      let pid = match affected_pid {
        Some(p) => p,
        None => continue,
      };

      if purged_persons.contains(&pid) { continue; }

      let count_resp = client
        .get(format!(
          "{supabase_url}/rest/v1/identities?person_id=eq.{pid}&user_id=eq.{user_id}&select=id"
        ))
        .header("apikey", &service_key)
        .header("Authorization", format!("Bearer {service_key}"))
        .header("Prefer", "count=exact")
        .header("Range", "0-0")
        .send().await;

      let total = count_resp.ok()
        .and_then(|r| r.headers().get("content-range")?.to_str().ok()
          .and_then(|s| s.split('/').last()?.parse::<usize>().ok()))
        .unwrap_or(1);

      if total <= 1 {
        purge_person(client, &supabase_url, &service_key, &pid, &user_id).await;
        purged_persons.insert(pid);
        purged += 1;
      }
    }
  }

  Ok(format!("Reconciled: purged {purged} persons"))
}

/// Fetch avatar from Unipile (direct URL or proxy endpoint), upload to
/// Supabase Storage, and update `persons.avatar_url` with the public URL.
/// Returns the public Storage URL on success.
async fn upload_avatar(
  client: &reqwest::Client,
  api_key: &str,
  unipile_base: &str,
  supabase_url: &str,
  service_key: &str,
  person_id: &str,
  attendee_id: &str,
  picture_url: Option<&str>,
) -> Option<String> {
  let mut image_bytes: Option<(Vec<u8>, String)> = None;

  if let Some(url) = picture_url {
    if let Ok(resp) = client.get(url).send().await {
      if resp.status().is_success() {
        let ct = resp.headers().get("content-type")
          .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        if let Ok(bytes) = resp.bytes().await {
          if !bytes.is_empty() {
            image_bytes = Some((bytes.to_vec(), ct));
          }
        }
      }
    }
  }

  if image_bytes.is_none() {
    let proxy_url = format!("{unipile_base}/api/v1/chat_attendees/{attendee_id}/picture");
    if let Ok(resp) = client.get(&proxy_url).header("X-API-KEY", api_key).send().await {
      if resp.status().is_success() {
        let ct = resp.headers().get("content-type")
          .and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        if let Ok(bytes) = resp.bytes().await {
          if !bytes.is_empty() {
            image_bytes = Some((bytes.to_vec(), ct));
          }
        }
      }
    }
  }

  let (bytes, content_type) = image_bytes?;

  let ext = if content_type.contains("png") { "png" }
    else if content_type.contains("webp") { "webp" }
    else { "jpg" };
  let object_path = format!("{person_id}.{ext}");

  let upload_url = format!(
    "{supabase_url}/storage/v1/object/avatars/{object_path}"
  );
  let upload_resp = client
    .post(&upload_url)
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", &content_type)
    .header("x-upsert", "true")
    .body(bytes)
    .send()
    .await;

  if let Ok(resp) = upload_resp {
    if !resp.status().is_success() {
      return None;
    }
  } else {
    return None;
  }

  let public_url = format!(
    "{supabase_url}/storage/v1/object/public/avatars/{object_path}"
  );

  let _ = client
    .patch(format!("{supabase_url}/rest/v1/persons?id=eq.{person_id}"))
    .header("apikey", service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .json(&serde_json::json!({
      "avatar_url": public_url,
      "avatar_stale": false,
      "avatar_refreshed_at": chrono::Utc::now().to_rfc3339()
    }))
    .send()
    .await;

  Some(public_url)
}

/// Delete avatar from Supabase Storage for a given person.
async fn delete_avatar(
  client: &reqwest::Client,
  supabase_url: &str,
  service_key: &str,
  person_id: &str,
) {
  for ext in &["jpg", "png", "webp"] {
    let _ = client
      .delete(format!(
        "{supabase_url}/storage/v1/object/avatars/{person_id}.{ext}"
      ))
      .header("apikey", service_key)
      .header("Authorization", format!("Bearer {service_key}"))
      .send()
      .await;
  }
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

const MAX_DROPPED_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[tauri::command]
async fn read_dropped_files(paths: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    let mut results = Vec::new();
    for p in &paths {
        let meta = std::fs::metadata(p).map_err(|e| format!("Stat {p}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("Not a regular file: {p}"));
        }
        if meta.len() > MAX_DROPPED_FILE_BYTES {
            return Err(format!(
                "{p} is {:.1}MB — attachments are limited to {}MB.",
                meta.len() as f64 / (1024.0 * 1024.0),
                MAX_DROPPED_FILE_BYTES / (1024 * 1024)
            ));
        }
        let data = std::fs::read(p).map_err(|e| format!("Read {p}: {e}"))?;
        let name = std::path::Path::new(p)
            .file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        let ext = std::path::Path::new(p)
            .extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
            "webp" => "image/webp", "svg" => "image/svg+xml", "bmp" => "image/bmp",
            "mp4" => "video/mp4", "webm" => "video/webm", "mov" => "video/quicktime",
            "pdf" => "application/pdf", "zip" => "application/zip",
            "mp3" => "audio/mpeg", "ogg" => "audio/ogg", "wav" => "audio/wav",
            "txt" => "text/plain", "html" => "text/html", "css" => "text/css",
            "json" => "application/json", "xml" => "application/xml",
            _ => "application/octet-stream",
        };
        let b64 = base64::Engine::encode(&base64_engine(), &data);
        results.push(serde_json::json!({
            "name": name, "data": b64, "mime": mime,
            "preview": if mime.starts_with("image/") {
                format!("data:{mime};base64,{b64}")
            } else { String::new() },
        }));
    }
    Ok(results)
}

fn base64_engine() -> base64::engine::GeneralPurpose {
  base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::general_purpose::PAD,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Build a minimal `attributedBody`-like blob: some garbage, then the
  /// `NSString` class marker, a class-ref gap, the `+` (0x2b) marker, a
  /// length prefix in the requested form, and the payload bytes.
  fn make_ab_blob(payload: &[u8], length_form: u8) -> Vec<u8> {
    let mut out: Vec<u8> = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01\x40".to_vec();
    out.extend_from_slice(b"NSString");
    out.extend_from_slice(&[0x01, 0x95, 0x84, 0x01]);
    out.push(0x2b);
    match length_form {
      // Direct length, payload must be < 0x80 bytes.
      0 => out.push(payload.len() as u8),
      // 0x81: next byte is length (0..=255).
      0x81 => { out.push(0x81); out.push(payload.len() as u8); }
      // 0x82: next 2 bytes little-endian.
      0x82 => {
        out.push(0x82);
        let len = payload.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
      }
      // 0x83: next 3 bytes little-endian.
      0x83 => {
        out.push(0x83);
        let len = payload.len() as u32;
        out.extend_from_slice(&len.to_le_bytes()[..3]);
      }
      _ => unreachable!("unsupported length_form in test helper"),
    }
    out.extend_from_slice(payload);
    out.extend_from_slice(&[0x86, 0x84, 0x02]);
    out
  }

  #[test]
  fn decodes_direct_length_ascii() {
    let payload = b"998117 is your Emirates one-time passcode.";
    let blob = make_ab_blob(payload, 0);
    assert_eq!(
      decode_attributed_body(&blob).as_deref(),
      Some("998117 is your Emirates one-time passcode."),
    );
  }

  #[test]
  fn decodes_direct_length_utf8() {
    // Arabic: the payload is multi-byte UTF-8 but still under 128 bytes.
    let payload = "Vercel هو 8855".as_bytes();
    let blob = make_ab_blob(payload, 0);
    assert_eq!(
      decode_attributed_body(&blob).as_deref(),
      Some("Vercel هو 8855"),
    );
  }

  #[test]
  fn decodes_0x81_length_over_127_bytes() {
    // 200-char ASCII message exceeds the single-byte-direct threshold and
    // forces the 0x81 length-prefix branch.
    let payload: Vec<u8> = std::iter::repeat(b'A').take(200).collect();
    let blob = make_ab_blob(&payload, 0x81);
    let out = decode_attributed_body(&blob).expect("should decode");
    assert_eq!(out.len(), 200);
    assert!(out.chars().all(|c| c == 'A'));
  }

  #[test]
  fn decodes_0x82_little_endian_length() {
    // 1000 bytes forces the 2-byte little-endian length prefix.
    let payload: Vec<u8> = (0..1000).map(|i| b'a' + (i % 26) as u8).collect();
    let blob = make_ab_blob(&payload, 0x82);
    let out = decode_attributed_body(&blob).expect("should decode");
    assert_eq!(out.len(), 1000);
    assert_eq!(out.as_bytes(), payload.as_slice());
  }

  #[test]
  fn returns_none_when_length_runs_off_end() {
    // Claim a 200-byte payload but only provide 10 bytes of data.
    let mut blob: Vec<u8> = b"NSString\x01\x95\x84\x01".to_vec();
    blob.push(0x2b);
    blob.push(0x81);
    blob.push(200);
    blob.extend_from_slice(b"too-short!");
    assert_eq!(decode_attributed_body(&blob), None);
  }

  #[test]
  fn returns_none_without_nsstring_marker() {
    let blob = b"garbage without the class marker \x2b\x05hello";
    assert_eq!(decode_attributed_body(blob), None);
  }

  #[test]
  fn returns_none_on_empty_blob() {
    assert_eq!(decode_attributed_body(&[]), None);
  }

  #[test]
  fn returns_none_on_unknown_length_marker() {
    let mut blob: Vec<u8> = b"NSString\x01\x95\x84\x01".to_vec();
    blob.push(0x2b);
    blob.push(0x84);
    blob.push(0x05);
    blob.extend_from_slice(b"hello");
    assert_eq!(decode_attributed_body(&blob), None);
  }
}

//! Tauri commands for the on-device bridge.
//!
//! Login flow (Instagram / Messenger):
//!   1. Frontend invokes [`on_device_start_login`] with `{ user_id, channel }`.
//!   2. Rust opens a `WebviewWindow` pointed at instagram.com / messenger.com.
//!   3. User logs in inside that window (including 2FA / checkpoints /
//!      consent modals — all handled by Meta's own site).
//!   4. Once the URL matches the "signed in and at the inbox" pattern, Rust
//!      lifts the required cookies off the webview via `with_webview` ->
//!      `wry::WebView::cookies()` and closes the window.
//!   5. Cookies are handed to the sidecar's `login` RPC, which instantiates a
//!      `messagix.Client`, calls `LoadMessagesPage`, and reports the account
//!      identity (or an `ErrChallenge`/`Consent`/`Checkpoint`/`Token`
//!      condition, which the frontend surfaces with a "log back in" prompt).
//!   6. On success, cookies are persisted to Keychain and the sidecar is
//!      flipped from login mode to event-streaming mode.
//!
//! Zero credentials ever transit Convolios code or servers. Only the session
//! cookies sitting on the user's machine are stored, and only in Keychain.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::keychain;
use super::rpc::{resolve_sidecar_path, BridgeHandle};
use super::BridgeManager;
use crate::AppState;

/// Name of the Go sidecar binary — one image handles both Instagram and
/// Messenger; the platform is chosen per-login in the RPC params.
const META_BRIDGE_BIN: &str = "meta-bridge";

const ON_DEVICE_PROVIDER: &str = "on_device";

/// Must match `messagix/useragent.UserAgent` in go.mau.fi/mautrix-meta so that
/// cookies minted during the webview login are accepted when the sidecar
/// replays them. Meta ties session cookies to the browser fingerprint.
const MESSAGIX_USER_AGENT: &str =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/// Per-platform configuration for the login webview. Keeping this in one
/// place makes it obvious to the next reader what cookies we need and how we
/// detect "user has successfully logged in" — both are easy to get subtly
/// wrong if they drift out of sync with mautrix-meta's upstream definitions.
///
/// Source of truth: `go.mau.fi/mautrix-meta/pkg/messagix/cookies` +
/// `pkg/connector/login.go`. When mautrix-meta revs their cookie list, we
/// rev this table.
struct PlatformConfig {
  channel: &'static str,
  start_url: &'static str,
  /// Cookie names that `messagix.NewClient` requires to build a logged-in
  /// client. Missing any one of these means the user hasn't completed login.
  required_cookies: &'static [&'static str],
  /// Cookie domain must end with one of these suffixes (after stripping a
  /// leading `.`). Meta sets session cookies on `.facebook.com` even when the
  /// login webview stays on `messenger.com`, so Messenger accepts both.
  domain_suffixes: &'static [&'static str],
  /// Regexes matched against the top-level navigation URL; any match means
  /// Meta has landed the user on authenticated UI and session cookies should
  /// be present (Messenger may finish on `facebook.com/messages` after SSO).
  logged_in_url_patterns: &'static [&'static str],
  /// Human title for the login window.
  window_title: &'static str,
  /// User-Agent string for the login webview. Must match the UA that the Go
  /// sidecar (messagix) will use when replaying the cookies — Meta ties
  /// session cookies to the browser fingerprint and rejects them from a
  /// mismatched UA.
  user_agent: &'static str,
}

const IG: PlatformConfig = PlatformConfig {
  channel: "instagram",
  start_url: "https://www.instagram.com/",
  required_cookies: &["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did"],
  domain_suffixes: &["instagram.com"],
  logged_in_url_patterns: &[r"^https://www\.instagram\.com/(?:direct/(?:inbox/|t/[0-9]+/)?)?(?:\?.*)?$"],
  window_title: "Connect Instagram",
  user_agent: MESSAGIX_USER_AGENT,
};

const MESSENGER: PlatformConfig = PlatformConfig {
  channel: "messenger",
  start_url: "https://www.messenger.com/?no_redirect=true",
  required_cookies: &["xs", "c_user", "datr"],
  domain_suffixes: &["messenger.com", "facebook.com"],
  logged_in_url_patterns: &[
    r"^https://www\.messenger\.com/?(?:e2ee/)?(?:inbox/?|t/[0-9]+/?)?(?:\?.*)?$",
    r"^https://www\.facebook\.com/messages(?:/.*)?(?:\?.*)?$",
  ],
  window_title: "Connect Messenger",
  user_agent: MESSAGIX_USER_AGENT,
};

fn platform_for(channel: &str) -> Result<&'static PlatformConfig, String> {
  match channel {
    "instagram" => Ok(&IG),
    "messenger" => Ok(&MESSENGER),
    other => Err(format!("unsupported on-device channel: {other}")),
  }
}

/// Outcome of a login attempt. `challenge_required` / `consent_required` /
/// `checkpoint_required` all route the user back to the real site to finish
/// whatever Meta is asking for, then they re-click Connect — cookies get
/// grabbed again with the cleared state. There is no in-app "submit a code"
/// flow; Meta doesn't expose one for cookie-based logins.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginOutcome {
  Success {
    account_id: String,
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    channel: String,
  },
  ChallengeRequired { channel: String },
  ConsentRequired { channel: String },
  CheckpointRequired { channel: String },
  TokenInvalidated { channel: String },
  Cancelled { channel: String },
}

#[tauri::command]
pub async fn on_device_start_login(
  user_id: String,
  channel: String,
  app: AppHandle,
  manager: State<'_, BridgeManager>,
  state: State<'_, AppState>,
) -> Result<LoginOutcome, String> {
  let cfg = platform_for(&channel)?;

  let cookies = match grab_cookies_via_webview(&app, cfg).await {
    Ok(c) => c,
    Err(GrabError::Cancelled) => {
      return Ok(LoginOutcome::Cancelled { channel: cfg.channel.to_string() })
    }
    Err(GrabError::Other(e)) => return Err(e),
  };

  let binary = resolve_sidecar_path(&app, META_BRIDGE_BIN)?;
  let handle = BridgeHandle::spawn(app.clone(), &binary, &[]).await?;

  let params = json!({
    "channel": cfg.channel,
    "cookies": cookies,
  });

  // Meta's LoadMessagesPage does a sequence of HTML module fetches to
  // discover the auth state; give it generous headroom.
  let result = handle
    .call_with_timeout("login", params, Duration::from_secs(60))
    .await;

  match result {
    Ok(value) => finalize_or_reject(user_id, cfg, value, handle, &manager, &state.http).await,
    Err(e) => {
      handle.shutdown().await;
      Err(e)
    }
  }
}

async fn finalize_or_reject(
  user_id: String,
  cfg: &PlatformConfig,
  value: Value,
  handle: BridgeHandle,
  manager: &BridgeManager,
  http: &reqwest::Client,
) -> Result<LoginOutcome, String> {
  let status = value
    .get("status")
    .and_then(|v| v.as_str())
    .unwrap_or("");

  match status {
    "success" => finalize_login(user_id, cfg, value, handle, manager, http).await,
    "challenge_required" => {
      handle.shutdown().await;
      Ok(LoginOutcome::ChallengeRequired { channel: cfg.channel.to_string() })
    }
    "consent_required" => {
      handle.shutdown().await;
      Ok(LoginOutcome::ConsentRequired { channel: cfg.channel.to_string() })
    }
    "checkpoint_required" => {
      handle.shutdown().await;
      Ok(LoginOutcome::CheckpointRequired { channel: cfg.channel.to_string() })
    }
    "token_invalidated" => {
      handle.shutdown().await;
      Ok(LoginOutcome::TokenInvalidated { channel: cfg.channel.to_string() })
    }
    other => {
      handle.shutdown().await;
      Err(format!("unexpected login status: {other}"))
    }
  }
}

async fn finalize_login(
  user_id: String,
  cfg: &PlatformConfig,
  value: Value,
  handle: BridgeHandle,
  manager: &BridgeManager,
  http: &reqwest::Client,
) -> Result<LoginOutcome, String> {
  let account_id = value
    .get("account_id")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "sidecar did not report account_id".to_string())?
    .to_string();
  let username = value
    .get("username")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string();
  let display_name = value
    .get("display_name")
    .and_then(|v| v.as_str())
    .map(String::from);
  let avatar_url = value
    .get("avatar_url")
    .and_then(|v| v.as_str())
    .map(String::from);
  // messagix may have refreshed / enriched the cookies during the login
  // load sequence (Meta rotates `xs` and sometimes `sessionid` on the first
  // hit from a new client). Store the sidecar's canonical copy, not the
  // one we grabbed off the webview.
  let canonical_cookies = value
    .get("cookies")
    .cloned()
    .ok_or_else(|| "sidecar did not report cookies on success".to_string())?;

  keychain::set_secret(
    ON_DEVICE_PROVIDER,
    &user_id,
    &account_id,
    &canonical_cookies.to_string(),
  )?;

  store_connected_account(
    http,
    &user_id,
    cfg.channel,
    &account_id,
    username.clone(),
    display_name.clone(),
    avatar_url.clone(),
  )
  .await?;

  handle.set_account_id(account_id.clone()).await;
  handle.set_user_id(user_id.clone()).await;

  handle
    .call("begin_events", json!({ "account_id": account_id }))
    .await?;

  manager.insert_active(account_id.clone(), handle).await;

  Ok(LoginOutcome::Success {
    account_id,
    username,
    display_name,
    avatar_url,
    channel: cfg.channel.to_string(),
  })
}

/// Spawn sidecars on app start for every on-device account that's already
/// connected. Idempotent — safe to call more than once; existing handles
/// are preserved by account id.
#[tauri::command]
pub async fn on_device_resume_all(
  user_id: String,
  app: AppHandle,
  manager: State<'_, BridgeManager>,
  state: State<'_, AppState>,
) -> Result<u32, String> {
  let accounts = match fetch_connected_accounts(&state.http, &user_id).await {
    Ok(a) => a,
    Err(e) => {
      eprintln!("[on_device] resume_all: fetch failed: {e}");
      return Err(e);
    }
  };
  let mut resumed = 0u32;

  for acc in accounts {
    let account_id = acc.account_id.clone();
    let channel = acc.channel.clone();

    if let Some(active) = manager.get_active(&account_id).await {
      if !active.is_closed() {
        continue;
      }
      manager.remove_active(&account_id).await;
    }

    let cookies = match keychain::get_secret(ON_DEVICE_PROVIDER, &user_id, &account_id)? {
      Some(s) => s,
      None => {
        eprintln!("[on_device] no keychain entry for {account_id}; user must reconnect");
        continue;
      }
    };
    let cookies: Value = serde_json::from_str(&cookies)
      .map_err(|e| format!("corrupt keychain entry for {account_id}: {e}"))?;

    let binary = resolve_sidecar_path(&app, META_BRIDGE_BIN)?;
    let handle = BridgeHandle::spawn(app.clone(), &binary, &[]).await?;
    handle.set_account_id(account_id.clone()).await;
    handle.set_user_id(user_id.clone()).await;

    if let Err(e) = handle
      .call(
        "resume",
        json!({
          "channel": channel,
          "account_id": account_id,
          "cookies": cookies,
        }),
      )
      .await
    {
      eprintln!("[on_device] resume failed for {account_id}: {e}");
      handle.shutdown().await;
      continue;
    }

    if let Err(e) = handle
      .call("begin_events", json!({ "account_id": account_id }))
      .await
    {
      eprintln!("[on_device] begin_events failed for {account_id}: {e}");
      handle.shutdown().await;
      continue;
    }

    manager.insert_active(account_id.clone(), handle).await;
    resumed += 1;
  }

  Ok(resumed)
}

#[tauri::command]
pub async fn on_device_disconnect(
  user_id: String,
  account_id: String,
  manager: State<'_, BridgeManager>,
  state: State<'_, AppState>,
) -> Result<String, String> {
  manager.remove_active(&account_id).await;
  keychain::delete_secret(ON_DEVICE_PROVIDER, &user_id, &account_id)?;
  delete_connected_account(&state.http, &user_id, &account_id).await?;
  Ok("disconnected".to_string())
}

#[tauri::command]
pub async fn on_device_update_cookies(
  user_id: String,
  account_id: String,
  cookies: String,
) -> Result<(), String> {
  keychain::set_secret(ON_DEVICE_PROVIDER, &user_id, &account_id, &cookies)?;
  Ok(())
}

/// Send an outbound message through the local bridge. Returns the provider
/// message id so the caller can dedupe against the inbound `message_received`
/// event that will echo the same message back from Meta.
pub async fn send_via_bridge(
  manager: &BridgeManager,
  account_id: &str,
  thread_id: &str,
  text: &str,
) -> Result<String, String> {
  let handle = manager
    .get_active(account_id)
    .await
    .ok_or_else(|| format!("no active on-device bridge for account {account_id}"))?;

  let response = handle
    .call(
      "send_message",
      json!({
        "account_id": account_id,
        "thread_id": thread_id,
        "text": text,
      }),
    )
    .await?;

  Ok(
    response
      .get("external_id")
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .to_string(),
  )
}

// ─── Cookie grabbing ─────────────────────────────────────────────────────

enum GrabError {
  /// User closed the login window before the platform's "logged in" URL
  /// pattern was reached. Not an error — a normal flow we report back.
  Cancelled,
  Other(String),
}

impl From<String> for GrabError {
  fn from(s: String) -> Self {
    GrabError::Other(s)
  }
}

/// Open the platform's login page in a dedicated webview window, wait for
/// the user to reach the logged-in state, then lift the required cookies.
///
/// Two paths out:
///   - URL matches any `logged_in_url_patterns` entry → extract cookies, close window,
///     return `Ok(cookie map)`.
///   - User closes the window manually → `GrabError::Cancelled`.
async fn grab_cookies_via_webview(
  app: &AppHandle,
  cfg: &'static PlatformConfig,
) -> Result<Value, GrabError> {
  let label = format!("on-device-login-{}", Uuid::new_v4().simple());

  let patterns: Vec<Regex> = cfg
    .logged_in_url_patterns
    .iter()
    .map(|p| Regex::new(p).map_err(|e| format!("compile pattern {p:?}: {e}")))
    .collect::<Result<_, _>>()?;

  // Sender is shared by the on_page_load closure (fires on successful nav)
  // and the CloseRequested handler (fires on manual close). First fire wins,
  // subsequent .take() calls return None.
  let (tx, rx) = oneshot::channel::<Result<(), GrabError>>();
  let tx = Arc::new(StdMutex::new(Some(tx)));

  let url: tauri::Url = cfg
    .start_url
    .parse()
    .map_err(|e| format!("parse start_url: {e}"))?;

  let tx_load = tx.clone();
  let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
    .title(cfg.window_title)
    .inner_size(520.0, 800.0)
    .min_inner_size(400.0, 600.0)
    .user_agent(cfg.user_agent)
    .focused(true)
    .on_page_load(move |_win, payload| {
      // Only fire on load finish — cookies only settle after Meta has
      // completed its HTTP round-trips and responded with Set-Cookie
      // headers; at load-start the webview's cookie store can still be
      // holding the previous page's state.
      if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
        return;
      }
      if patterns
        .iter()
        .any(|re| re.is_match(payload.url().as_str()))
      {
        if let Some(sender) = tx_load.lock().ok().and_then(|mut g| g.take()) {
          let _ = sender.send(Ok(()));
        }
      }
    })
    .build()
    .map_err(|e| format!("open login window: {e}"))?;

  let tx_close = tx.clone();
  // Manual close → Cancelled. Note: we ALSO close the window after a
  // successful cookie grab; in that case the sender has already been taken,
  // so this handler's branch is a no-op.
  window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
      if let Some(sender) = tx_close.lock().ok().and_then(|mut g| g.take()) {
        let _ = sender.send(Err(GrabError::Cancelled));
      }
    }
  });

  match rx.await {
    Ok(Ok(())) => {
      let cookies = extract_required_cookies(&window, cfg).await?;
      let _ = window.close();
      Ok(cookies)
    }
    Ok(Err(e)) => Err(e),
    Err(_) => Err(GrabError::Other(
      "login channel closed unexpectedly".to_string(),
    )),
  }
}

/// A cookie name/value pair pulled off the webview's native store. Kept
/// minimal on purpose — the sidecar rebuilds a full cookie jar on the Go
/// side using the list of names `messagix` expects, so we only need what
/// name/value/domain we saw on the wire.
#[derive(Debug, Clone)]
struct ExtractedCookie {
  name: String,
  value: String,
  domain: String,
}

/// Pull the cookies `messagix` needs off the login webview, then shape
/// them into the `{ name: value }` map the sidecar's `login` RPC expects.
///
/// Missing any required cookie is a hard error — it means Meta's page
/// hasn't settled to the logged-in state yet, and handing the sidecar a
/// partial jar would produce a `messagix.Client` that fails on its first
/// request with an unhelpful "missing auth" error.
async fn extract_required_cookies(
  window: &WebviewWindow,
  cfg: &PlatformConfig,
) -> Result<Value, String> {
  // Meta often sets `xs` / `c_user` on `.facebook.com` while duplicate names on
  // `.messenger.com` can be empty placeholders; WKCookieStore can also lag one
  // frame behind navigation. Merge two reads and pick the best value per name.
  let mut all = pull_cookies_from_webview(window).await?;
  all.extend(pull_cookies_from_webview(window).await?);

  let mut jar = serde_json::Map::new();
  for &name in cfg.required_cookies {
    match pick_best_cookie(&all, name, cfg.domain_suffixes) {
      Some(c) if !c.value.is_empty() => {
        jar.insert(name.to_string(), Value::String(c.value.clone()));
      }
      _ => {
        return Err(format!(
          "required cookie `{name}` for {} not present after login; retry",
          cfg.channel,
        ))
      }
    }
  }

  Ok(Value::Object(jar))
}

fn cookie_domain_allowed(domain: &str, suffixes: &[&str]) -> bool {
  let d = domain.trim_start_matches('.');
  suffixes.iter().any(|s| {
    d == *s
      || (d.len() > s.len()
        && d.as_bytes().get(d.len() - s.len() - 1) == Some(&b'.')
        && d.ends_with(s))
  })
}

/// When several cookies share a name (common for `xs` across messenger.com vs
/// facebook.com), prefer a non-empty value and facebook.com over messenger.com.
fn pick_best_cookie<'a>(
  jar: &'a [ExtractedCookie],
  name: &str,
  domain_suffixes: &[&str],
) -> Option<&'a ExtractedCookie> {
  jar
    .iter()
    .filter(|c| c.name == name && cookie_domain_allowed(&c.domain, domain_suffixes))
    .max_by_key(|c| {
      let d = c.domain.trim_start_matches('.');
      let domain_pri = if d.ends_with("facebook.com") {
        2u8
      } else if d.ends_with("messenger.com") {
        1u8
      } else {
        0u8
      };
      (!c.value.is_empty(), domain_pri, c.value.len())
    })
}

// ─── macOS: native WKHTTPCookieStore bridge ──────────────────────────────

/// Pull all cookies from the login webview's WKHTTPCookieStore.
///
/// WKWebView stores its cookies outside of NSHTTPCookieStorage, including
/// HttpOnly session cookies which JS can't see via `document.cookie`. The
/// only way to reach them from Rust is through `WKWebView.configuration
/// .websiteDataStore.httpCookieStore.getAllCookies(_:)` — async, callback
/// fires on the cookie-store's own queue.
///
/// Tauri's `with_webview` hands us a `*mut c_void` to the native WKWebView;
/// we cast it to `WKWebView`, walk the configuration chain, and bridge the
/// async callback into a `tokio::oneshot`.
#[cfg(target_os = "macos")]
async fn pull_cookies_from_webview(
  window: &WebviewWindow,
) -> Result<Vec<ExtractedCookie>, String> {
  use objc2::rc::Retained;
  use objc2_foundation::{NSArray, NSHTTPCookie};
  use objc2_web_kit::WKWebView;

  let (tx, rx) = oneshot::channel::<Vec<ExtractedCookie>>();
  let tx_outer: Arc<StdMutex<Option<oneshot::Sender<Vec<ExtractedCookie>>>>> =
    Arc::new(StdMutex::new(Some(tx)));
  let tx_cb = tx_outer.clone();

  window
    .with_webview(move |platform_webview| {
      // SAFETY: tauri-runtime-wry hands us a Retained<WKWebView> that was
      // raised to a raw pointer via `Retained::into_raw`. We reclaim it
      // here so the retain count is balanced — without this, the
      // WKWebView would leak on every `with_webview` call.
      // tauri-runtime-wry's macOS `Webview` struct raises each handle with
      // `Retained::into_raw`, so reclaiming via `Retained::from_raw` here
      // balances that retain count — not doing this leaks one WKWebView
      // per login attempt.
      let wkwebview: Retained<WKWebView> = unsafe {
        Retained::from_raw(platform_webview.inner() as *mut WKWebView)
          .expect("tauri handed us a null WKWebView pointer")
      };
      let config = unsafe { wkwebview.configuration() };
      let data_store = unsafe { config.websiteDataStore() };
      let cookie_store = unsafe { data_store.httpCookieStore() };

      let tx_block = tx_cb.clone();
      let block = block2::RcBlock::new(
        move |cookies: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
          let arr: &NSArray<NSHTTPCookie> = unsafe { cookies.as_ref() };
          let extracted: Vec<ExtractedCookie> = arr
            .iter()
            .map(|c| ExtractedCookie {
              name: c.name().to_string(),
              value: c.value().to_string(),
              domain: c.domain().to_string(),
            })
            .collect();
          if let Some(sender) = tx_block.lock().ok().and_then(|mut g| g.take()) {
            let _ = sender.send(extracted);
          }
        },
      );
      unsafe { cookie_store.getAllCookies(&block) };
    })
    .map_err(|e| format!("with_webview: {e}"))?;

  match tokio::time::timeout(Duration::from_secs(10), rx).await {
    Ok(Ok(cookies)) => Ok(cookies),
    Ok(Err(_)) => Err("cookie channel closed before WKHTTPCookieStore responded".into()),
    Err(_) => Err("timed out waiting for WKHTTPCookieStore.getAllCookies".into()),
  }
}

#[cfg(not(target_os = "macos"))]
async fn pull_cookies_from_webview(
  _window: &WebviewWindow,
) -> Result<Vec<ExtractedCookie>, String> {
  Err("on-device login is macOS-only in this build".into())
}

// ─── Supabase plumbing ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ConnectedAccountRow {
  account_id: String,
  channel: String,
}

async fn fetch_connected_accounts(
  http: &reqwest::Client,
  user_id: &str,
) -> Result<Vec<ConnectedAccountRow>, String> {
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let resp = http
    .get(format!(
      "{supabase_url}/rest/v1/connected_accounts?provider=eq.on_device&user_id=eq.{user_id}&status=eq.active&select=account_id,channel"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .timeout(std::time::Duration::from_secs(8))
    .send()
    .await
    .map_err(|e| format!("fetch accounts: {e}"))?;

  if !resp.status().is_success() {
    let s = resp.status();
    let b = resp.text().await.unwrap_or_default();
    return Err(format!("fetch accounts {s}: {b}"));
  }

  resp.json::<Vec<ConnectedAccountRow>>()
    .await
    .map_err(|e| format!("parse accounts: {e}"))
}

async fn store_connected_account(
  http: &reqwest::Client,
  user_id: &str,
  channel: &str,
  account_id: &str,
  username: String,
  display_name: Option<String>,
  avatar_url: Option<String>,
) -> Result<(), String> {
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let now = chrono::Utc::now().to_rfc3339();
  // Messenger: inbound `message_received` / inbox pipeline is tracked separately; keep UI honest
  // until `receive_inbox_ready` is set true (see AccountCard in Settings).
  let connection_params = if channel == "messenger" {
    json!({ "bridge": "meta-bridge", "receive_inbox_ready": false })
  } else {
    json!({ "bridge": "meta-bridge" })
  };
  let row = json!({
    "user_id": user_id,
    "provider": ON_DEVICE_PROVIDER,
    "channel": channel,
    "account_id": account_id,
    "status": "active",
    "display_name": display_name,
    "username": username,
    "avatar_url": avatar_url,
    "provider_type": match channel {
      "instagram" => "Instagram (on device)",
      "messenger" => "Messenger (on device)",
      _ => channel,
    },
    "connection_params": connection_params,
    "last_synced_at": now,
    "updated_at": now,
  });

  let resp = http
    .post(format!(
      "{supabase_url}/rest/v1/connected_accounts?on_conflict=user_id,provider,account_id"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .header("Content-Type", "application/json")
    .header("Prefer", "resolution=merge-duplicates")
    .json(&row)
    .send()
    .await
    .map_err(|e| format!("store account: {e}"))?;

  if !resp.status().is_success() && resp.status().as_u16() != 409 {
    let s = resp.status();
    let b = resp.text().await.unwrap_or_default();
    return Err(format!("store account {s}: {b}"));
  }
  Ok(())
}

async fn delete_connected_account(
  http: &reqwest::Client,
  user_id: &str,
  account_id: &str,
) -> Result<(), String> {
  let supabase_url =
    std::env::var("VITE_SUPABASE_URL").map_err(|_| "VITE_SUPABASE_URL not set".to_string())?;
  let service_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
    .map_err(|_| "SUPABASE_SERVICE_ROLE_KEY not set".to_string())?;

  let resp = http
    .delete(format!(
      "{supabase_url}/rest/v1/connected_accounts?provider=eq.on_device&user_id=eq.{user_id}&account_id=eq.{account_id}"
    ))
    .header("apikey", &service_key)
    .header("Authorization", format!("Bearer {service_key}"))
    .send()
    .await
    .map_err(|e| format!("delete account: {e}"))?;

  if !resp.status().is_success() {
    let s = resp.status();
    let b = resp.text().await.unwrap_or_default();
    return Err(format!("delete account {s}: {b}"));
  }
  Ok(())
}

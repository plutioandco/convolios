//! Transport layer for talking to a local bridge sidecar.
//!
//! The sidecar is a separate native binary (e.g. the Go `meta-bridge` that
//! wraps mautrix-meta's messagix). Rust spawns it with `--socket <path>` and
//! a sidecar-chosen `--log-level`. The sidecar creates and listens on that
//! Unix socket, then prints a single `ready` line on stdout; Rust reads that
//! sentinel and connects.
//!
//! Once connected, the two sides speak **newline-delimited JSON-RPC 2.0**:
//! every line is a complete JSON object. Requests get numeric ids and expect
//! matching responses; notifications (server-initiated events like
//! `message_received`) carry no id.
//!
//! Lifecycle is owned by [`BridgeHandle`]. Dropping all clones of a handle
//! does not terminate the sidecar — only an explicit `shutdown()` does. This
//! is deliberate: callers that want to peek at a bridge without tearing it
//! down are the common case.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use uuid::Uuid;

/// Default per-call timeout. Chosen so a slow login challenge (2FA SMS) still
/// completes, but a hung sidecar is noticed and the UI can retry.
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(60);

/// Wait up to this long for the sidecar to print its "ready" sentinel.
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Connect retry window — the sidecar may finish binding the socket a tick
/// after it prints "ready" on some platforms.
const CONNECT_RETRY_FOR: Duration = Duration::from_secs(3);

/// A message received from the sidecar that isn't a response to one of our
/// requests. Re-emitted as a Tauri event for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnDeviceEvent {
  /// Event type, e.g. `"message_received"`, `"account_status"`.
  #[serde(rename = "type")]
  pub kind: String,
  pub account_id: String,
  pub channel: String,
  #[serde(default)]
  pub payload: Value,
}

/// Shared handle to a running sidecar. Clones are cheap and share the same
/// underlying process + RPC channel.
#[derive(Clone)]
pub struct BridgeHandle {
  inner: Arc<BridgeInner>,
}

struct BridgeInner {
  /// Sidecar-reported account id. May be empty during the login flow, before
  /// the sidecar has resolved the user's provider account id.
  account_id: Mutex<String>,
  /// User id of the Convolios user who owns this bridge session.
  user_id: Mutex<String>,
  /// Outbound queue — RPC requests and a shutdown signal.
  tx: mpsc::Sender<Outbound>,
  /// Active in-flight requests, keyed by RPC id.
  pending: Mutex<HashMap<u64, oneshot::Sender<RpcResponse>>>,
  /// Next request id. Monotonic; we don't reuse ids even after a response
  /// lands so logs stay unambiguous.
  next_id: std::sync::atomic::AtomicU64,
  /// Child process. Kept alive so Drop on shutdown kills the sidecar.
  child: Mutex<Option<Child>>,
  /// Socket path — cleaned up on shutdown.
  socket_path: PathBuf,
  /// Set when the RPC reader exits so stale handles can be replaced.
  closed: AtomicBool,
}

enum Outbound {
  Request(Value),
  Shutdown,
}

#[derive(Debug, Deserialize)]
struct RpcResponse {
  #[serde(default)]
  result: Option<Value>,
  #[serde(default)]
  error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
pub struct RpcError {
  pub code: i64,
  pub message: String,
}

impl BridgeHandle {
  /// Spawn a sidecar binary at `binary`, hand it a fresh Unix socket path,
  /// wait for it to be ready, and open the RPC channel.
  ///
  /// `app` is used to forward server-side events as Tauri events.
  /// `extra_args` lets callers pass bridge-specific flags (e.g. a log dir).
  pub async fn spawn(
    app: AppHandle,
    binary: &Path,
    extra_args: &[String],
  ) -> Result<Self, String> {
    let socket_path = fresh_socket_path()?;
    let _ = std::fs::remove_file(&socket_path);

    let mut cmd = Command::new(binary);
    cmd.arg("--socket").arg(&socket_path);
    for a in extra_args {
      cmd.arg(a);
    }
    cmd.stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .kill_on_drop(true);

    let mut child = cmd
      .spawn()
      .map_err(|e| format!("sidecar spawn failed ({}): {e}", binary.display()))?;

    // Stream stderr through the Rust log so panics / startup failures surface.
    if let Some(stderr) = child.stderr.take() {
      let label = binary.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sidecar")
        .to_string();
      tokio::spawn(forward_stderr(stderr, label));
    }

    // Sidecar prints "ready\n" once its socket is bound. We read stdout until
    // that line or timeout.
    let stdout = child.stdout.take().ok_or_else(|| "sidecar has no stdout".to_string())?;
    let ready_result = timeout(SIDECAR_READY_TIMEOUT, wait_for_ready(stdout)).await;

    match ready_result {
      Ok(Ok(())) => {}
      Ok(Err(e)) => {
        let _ = child.kill().await;
        return Err(format!("sidecar readiness error: {e}"));
      }
      Err(_) => {
        let _ = child.kill().await;
        return Err("sidecar did not become ready in time".to_string());
      }
    }

    // Small retry loop: the sentinel is printed just before listen() on some
    // runtimes; give the socket a few ms to actually accept connections.
    let stream = match connect_with_retries(&socket_path, CONNECT_RETRY_FOR).await {
      Ok(s) => s,
      Err(e) => {
        let _ = child.start_kill();
        return Err(format!("sidecar connect: {e}"));
      }
    };

    let (reader, writer) = stream.into_split();

    let (outbound_tx, outbound_rx) = mpsc::channel::<Outbound>(64);
    let inner = Arc::new(BridgeInner {
      account_id: Mutex::new(String::new()),
      user_id: Mutex::new(String::new()),
      tx: outbound_tx,
      pending: Mutex::new(HashMap::new()),
      next_id: std::sync::atomic::AtomicU64::new(1),
      child: Mutex::new(Some(child)),
      socket_path: socket_path.clone(),
      closed: AtomicBool::new(false),
    });

    // Writer task: drains outbound queue onto the socket.
    tokio::spawn(writer_task(writer, outbound_rx));

    // Reader task: routes responses to pending waiters and forwards
    // notifications as Tauri events.
    tokio::spawn(reader_task(
      BufReader::new(reader),
      inner.clone(),
      app.clone(),
    ));

    Ok(Self { inner })
  }

  /// Issue a request and wait for the matching response. Returns the `result`
  /// field or the remote error. Times out per [`DEFAULT_RPC_TIMEOUT`].
  pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
    self.call_with_timeout(method, params, DEFAULT_RPC_TIMEOUT).await
  }

  pub async fn call_with_timeout(
    &self,
    method: &str,
    params: Value,
    t: Duration,
  ) -> Result<Value, String> {
    let id = self.inner.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let request = serde_json::json!({
      "jsonrpc": "2.0",
      "id": id,
      "method": method,
      "params": params,
    });

    let (resp_tx, resp_rx) = oneshot::channel();
    {
      let mut pending = self.inner.pending.lock().await;
      pending.insert(id, resp_tx);
    }

    self.inner
      .tx
      .send(Outbound::Request(request))
      .await
      .map_err(|_| "bridge is closed".to_string())?;

    let resp = match timeout(t, resp_rx).await {
      Ok(Ok(r)) => r,
      Ok(Err(_)) => return Err("bridge reader dropped response channel".to_string()),
      Err(_) => {
        // Clean up pending entry on timeout so a late response doesn't leak.
        let mut pending = self.inner.pending.lock().await;
        pending.remove(&id);
        return Err(format!("rpc {method} timed out after {:?}", t));
      }
    };

    if let Some(err) = resp.error {
      return Err(format!("rpc {method} error ({}): {}", err.code, err.message));
    }
    Ok(resp.result.unwrap_or(Value::Null))
  }

  /// Record the provider account id the sidecar resolved for this session.
  pub async fn set_account_id(&self, id: String) {
    let mut guard = self.inner.account_id.lock().await;
    *guard = id;
  }

  pub async fn set_user_id(&self, id: String) {
    let mut guard = self.inner.user_id.lock().await;
    *guard = id;
  }

  pub fn is_closed(&self) -> bool {
    self.inner.closed.load(Ordering::SeqCst)
  }

  #[allow(dead_code)]
  pub async fn account_id(&self) -> String {
    self.inner.account_id.lock().await.clone()
  }

  /// Shut the sidecar down: sends the quit sentinel, kills the process if it
  /// doesn't exit promptly, removes the socket. Idempotent.
  pub async fn shutdown(&self) {
    let _ = self.inner.tx.send(Outbound::Shutdown).await;

    let mut child_guard = self.inner.child.lock().await;
    if let Some(mut child) = child_guard.take() {
      // Give the sidecar a brief grace period to exit cleanly on the quit
      // sentinel, then force kill.
      let _ = timeout(Duration::from_secs(2), child.wait()).await;
      let _ = child.kill().await;
      let _ = child.wait().await;
    }
    drop(child_guard);

    let _ = std::fs::remove_file(&self.inner.socket_path);
  }
}

fn fresh_socket_path() -> Result<PathBuf, String> {
  // macOS / BSD cap `sockaddr_un.sun_path` at 104 bytes (Linux gets 108).
  // `std::env::temp_dir()` on macOS returns `/var/folders/xx/yyyyy/T/`
  // (~49 chars) which leaves almost nothing for our filename, so we pin
  // the socket under `/tmp` and use a short suffix. Full budget here is
  // well under 40 bytes.
  let base: PathBuf = if cfg!(unix) {
    PathBuf::from("/tmp")
  } else {
    std::env::temp_dir()
  };
  // 8 hex chars of a UUID is plenty of entropy for collision avoidance
  // between concurrent sidecars on one machine.
  let short = Uuid::new_v4().simple().to_string();
  let name = format!("cvo-br-{}.sock", &short[..8]);
  Ok(base.join(name))
}

async fn wait_for_ready(stdout: tokio::process::ChildStdout) -> Result<(), String> {
  let mut lines = BufReader::new(stdout).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    let trimmed = line.trim();
    if trimmed == "ready" {
      // Drain remaining stdout in the background so a chatty sidecar doesn't
      // block its own pipe. We rely on stderr for actual diagnostics.
      tokio::spawn(async move {
        while let Ok(Some(_)) = lines.next_line().await {}
      });
      return Ok(());
    }
  }
  Err("sidecar stdout closed before ready".to_string())
}

async fn forward_stderr(stderr: tokio::process::ChildStderr, label: String) {
  let mut lines = BufReader::new(stderr).lines();
  while let Ok(Some(line)) = lines.next_line().await {
    eprintln!("[{label}] {line}");
  }
}

async fn connect_with_retries(path: &Path, for_: Duration) -> Result<UnixStream, String> {
  let deadline = tokio::time::Instant::now() + for_;
  loop {
    match UnixStream::connect(path).await {
      Ok(s) => return Ok(s),
      Err(e) => {
        if tokio::time::Instant::now() >= deadline {
          return Err(e.to_string());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
      }
    }
  }
}

async fn writer_task(
  mut writer: tokio::net::unix::OwnedWriteHalf,
  mut rx: mpsc::Receiver<Outbound>,
) {
  while let Some(out) = rx.recv().await {
    match out {
      Outbound::Request(v) => {
        let Ok(mut bytes) = serde_json::to_vec(&v) else {
          continue;
        };
        bytes.push(b'\n');
        if writer.write_all(&bytes).await.is_err() {
          break;
        }
      }
      Outbound::Shutdown => {
        let _ = writer
          .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"shutdown\"}\n")
          .await;
        let _ = writer.shutdown().await;
        break;
      }
    }
  }
}

async fn reader_task<R>(
  mut reader: BufReader<R>,
  inner: Arc<BridgeInner>,
  app: AppHandle,
) where
  R: tokio::io::AsyncRead + Unpin,
{
  let http = app.state::<crate::AppState>().http.clone();
  let supabase_url = std::env::var("VITE_SUPABASE_URL").unwrap_or_default();
  let webhook_secret = std::env::var("UNIPILE_WEBHOOK_SECRET").unwrap_or_default();
  let webhook_url = format!("{supabase_url}/functions/v1/unipile-webhook");

  let mut line = String::new();
  loop {
    line.clear();
    match reader.read_line(&mut line).await {
      Ok(0) => break,
      Ok(_) => {}
      Err(_) => break,
    }

    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }

    let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
      eprintln!("[on_device] bad JSON from sidecar: {trimmed}");
      continue;
    };

    // Dispatch: responses have an `id`, notifications have a `method`.
    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
      let resp: Result<RpcResponse, _> = serde_json::from_value(msg);
      if let Ok(resp) = resp {
        let mut pending = inner.pending.lock().await;
        if let Some(tx) = pending.remove(&id) {
          let _ = tx.send(resp);
        }
      }
      continue;
    }

    if msg.get("method").and_then(|v| v.as_str()) == Some("event") {
      let event: Result<OnDeviceEvent, _> =
        serde_json::from_value(msg.get("params").cloned().unwrap_or(Value::Null));
      match event {
        Ok(ev) => {
          // Forward message_received events directly to the webhook from
          // Rust — bypasses the fragile frontend → fetch → webhook hop
          // that can lose messages during HMR or cold starts.
          if ev.kind == "message_received" && !webhook_secret.is_empty() {
            let user_id = inner.user_id.lock().await.clone();
            if user_id.is_empty() {
              eprintln!("[on_device] dropping message_received — user_id not set yet (account={})", ev.account_id);
            } else {
            let body = serde_json::json!({
              "event": "on_device.message_received",
              "account_id": ev.account_id,
              "channel": ev.channel,
            })
            .as_object()
            .cloned()
            .unwrap_or_default();

            let mut merged = body;
            if let Value::Object(payload_map) = &ev.payload {
              for (k, v) in payload_map {
                merged.insert(k.clone(), v.clone());
              }
            }

            post_event_to_webhook(&http, &webhook_url, &webhook_secret, &user_id, Value::Object(merged)).await;
            }
          }

          if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("on_device:event", &ev);
          } else {
            let _ = app.emit("on_device:event", &ev);
          }
        }
        Err(e) => {
          eprintln!("[on_device] malformed event: {e}");
        }
      }
    }
  }

  // Socket closed — drop all pending waiters with an error.
  inner.closed.store(true, Ordering::SeqCst);
  let mut pending = inner.pending.lock().await;
  for (_, tx) in pending.drain() {
    let _ = tx.send(RpcResponse {
      result: None,
      error: Some(RpcError {
        code: -32003,
        message: "bridge socket closed".to_string(),
      }),
    });
  }
}

async fn post_event_to_webhook(
  http: &reqwest::Client,
  url: &str,
  webhook_secret: &str,
  user_id: &str,
  body: Value,
) {
  let delays = [0u64, 2000, 4000, 8000];
  for (i, delay) in delays.iter().enumerate() {
    if *delay > 0 {
      tokio::time::sleep(std::time::Duration::from_millis(*delay)).await;
    }
    match http
      .post(url)
      .header("x-webhook-secret", webhook_secret)
      .header("x-on-device-user-id", user_id)
      .json(&body)
      .timeout(std::time::Duration::from_secs(30))
      .send()
      .await
    {
      Ok(resp) if resp.status().is_success() => return,
      Ok(resp) if resp.status().as_u16() < 500 && resp.status().as_u16() != 429 => {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        eprintln!("[on_device] webhook {status} (non-retryable): {text}");
        return;
      }
      Ok(resp) => {
        eprintln!("[on_device] webhook {} — retrying ({}/{})", resp.status(), i + 1, delays.len());
      }
      Err(e) => {
        eprintln!("[on_device] webhook failed — retrying ({}/{}): {e:?}", i + 1, delays.len());
      }
    }
  }
  eprintln!("[on_device] webhook delivery failed after all retries");
}

/// Resolve the path to a bridged sidecar binary.
///
/// Looks, in order:
///   1. `<resource_dir>/<name>` — Tauri's externalBin root.
///   2. `<resource_dir>/binaries/<name>-<target-triple>` — the name Tauri 2
///      uses when it copies externalBin into the bundle.
///   3. `<manifest_dir>/sidecars/<name>/<name>` — dev fallback for
///      `cargo run` / `tauri dev`, which does not consult externalBin.
pub fn resolve_sidecar_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
  let exe_name = if cfg!(windows) {
    format!("{name}.exe")
  } else {
    name.to_string()
  };

  let mut attempts: Vec<PathBuf> = Vec::new();

  if let Ok(resource_dir) = app.path().resource_dir() {
    let a = resource_dir.join(&exe_name);
    attempts.push(a.clone());
    if a.exists() {
      return Ok(a);
    }

    let triple = target_triple();
    let triple_name = if cfg!(windows) {
      format!("{name}-{triple}.exe")
    } else {
      format!("{name}-{triple}")
    };
    let b = resource_dir.join("binaries").join(&triple_name);
    attempts.push(b.clone());
    if b.exists() {
      return Ok(b);
    }
    // Some Tauri versions place them flat in the resource dir.
    let b2 = resource_dir.join(&triple_name);
    attempts.push(b2.clone());
    if b2.exists() {
      return Ok(b2);
    }
  }

  let manifest_dir = env!("CARGO_MANIFEST_DIR");
  let dev_candidate = Path::new(manifest_dir)
    .join("sidecars")
    .join(name)
    .join(&exe_name);
  attempts.push(dev_candidate.clone());
  if dev_candidate.exists() {
    return Ok(dev_candidate);
  }

  Err(format!(
    "sidecar binary `{}` not found. Tried: {}",
    exe_name,
    attempts.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
  ))
}

/// Runtime-constructed target triple. Matches the suffix Tauri appends when
/// packaging externalBin binaries. Covers the platforms Convolios ships to.
fn target_triple() -> String {
  let arch = std::env::consts::ARCH;
  let suffix = match std::env::consts::OS {
    "macos" => "apple-darwin",
    "linux" => "unknown-linux-gnu",
    "windows" => "pc-windows-msvc",
    other => other,
  };
  format!("{arch}-{suffix}")
}

//! On-device messaging bridge.
//!
//! Convolios supports two classes of messaging providers:
//!
//!  - **Hosted** (`provider='unipile'` etc.) — a third-party service holds
//!    the user's session and relays messages to us over a webhook.
//!  - **On-device** (`provider='on_device'`) — a native sidecar process runs
//!    locally on the user's Mac, connects to the underlying messaging
//!    service from the user's home IP, and streams events to the Convolios
//!    backend via Tauri IPC. Session cookies live in the macOS Keychain
//!    only — never on our servers, never in Supabase.
//!
//! This module owns the lifecycle of the sidecar processes and the
//! JSON-RPC channel the Rust backend uses to talk to them. Events received
//! from a sidecar are re-emitted as Tauri events (`on_device:event`) so
//! the React frontend can forward them to the `unipile-webhook` Edge
//! Function using the user's live Supabase JWT. The Rust layer never
//! handles auth tokens.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub mod commands;
pub mod keychain;
pub mod rpc;

pub use rpc::BridgeHandle;

/// In-process registry of live bridge sidecars, keyed by the on-device
/// account id (the provider's native user id, e.g. an Instagram user id).
///
/// A connected account has exactly one sidecar process backing it. Starting
/// a second sidecar for the same account id replaces the first — useful
/// after a reconnect or cookie refresh.
#[derive(Clone, Default)]
pub struct BridgeManager {
  active: Arc<Mutex<HashMap<String, BridgeHandle>>>,
}

impl BridgeManager {
  pub fn new() -> Self {
    Self::default()
  }

  pub async fn insert_active(&self, account_id: String, handle: BridgeHandle) {
    let mut guard = self.active.lock().await;
    if let Some(existing) = guard.insert(account_id, handle) {
      existing.shutdown().await;
    }
  }

  pub async fn get_active(&self, account_id: &str) -> Option<BridgeHandle> {
    let guard = self.active.lock().await;
    guard.get(account_id).cloned()
  }

  pub async fn remove_active(&self, account_id: &str) {
    let mut guard = self.active.lock().await;
    if let Some(handle) = guard.remove(account_id) {
      handle.shutdown().await;
    }
  }

  #[allow(dead_code)]
  pub async fn shutdown_all(&self) {
    let mut active = self.active.lock().await;
    let handles: Vec<BridgeHandle> = active.drain().map(|(_, h)| h).collect();
    drop(active);
    for h in handles {
      h.shutdown().await;
    }
  }
}

/// Provider channels that route through the on-device bridge today.
pub fn is_on_device_channel(channel: &str) -> bool {
  matches!(channel, "instagram" | "messenger")
}

/// Keychain service label. Each secret also includes the Supabase user id
/// and the on-device account id so multiple accounts / multiple logged-in
/// users on the same Mac don't collide.
pub(crate) const KEYCHAIN_SERVICE: &str = "com.plutioandco.convolios.on_device";

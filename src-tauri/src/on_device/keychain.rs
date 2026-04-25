//! macOS Keychain wrappers for on-device bridge credentials.
//!
//! Every persistent credential we hold for a local bridge — session cookies,
//! device tokens, MQTT keys — lives here, never in Supabase, never on disk.
//! The `keyring` crate abstracts the platform-native store: Keychain on macOS,
//! Credential Manager on Windows, libsecret on Linux.
//!
//! Account isolation: every entry is keyed by `(provider, supabase_user_id,
//! account_id)`, which means two Convolios accounts on the same Mac or two
//! on-device bridges for the same user never read each other's secrets.
//!
//! In debug builds the keychain prompt blocks the async runtime on every
//! recompile because the binary identity changes. We fall back to a JSON
//! file in the platform data directory.

use super::KEYCHAIN_SERVICE;

fn account_key(provider: &str, supabase_user_id: &str, account_id: &str) -> String {
  format!("{provider}|{supabase_user_id}|{account_id}")
}

#[cfg(not(debug_assertions))]
mod inner {
  use super::*;
  use keyring::Entry;

  fn entry(provider: &str, supabase_user_id: &str, account_id: &str) -> Result<Entry, String> {
    let user = account_key(provider, supabase_user_id, account_id);
    Entry::new(KEYCHAIN_SERVICE, &user).map_err(|e| format!("keychain entry: {e}"))
  }

  pub fn set_secret(
    provider: &str,
    supabase_user_id: &str,
    account_id: &str,
    secret: &str,
  ) -> Result<(), String> {
    entry(provider, supabase_user_id, account_id)?
      .set_password(secret)
      .map_err(|e| format!("keychain set: {e}"))
  }

  pub fn get_secret(
    provider: &str,
    supabase_user_id: &str,
    account_id: &str,
  ) -> Result<Option<String>, String> {
    match entry(provider, supabase_user_id, account_id)?.get_password() {
      Ok(s) => Ok(Some(s)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(format!("keychain get: {e}")),
    }
  }

  pub fn delete_secret(
    provider: &str,
    supabase_user_id: &str,
    account_id: &str,
  ) -> Result<(), String> {
    match entry(provider, supabase_user_id, account_id)?.delete_credential() {
      Ok(_) => Ok(()),
      Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("keychain delete: {e}")),
    }
  }
}

#[cfg(debug_assertions)]
mod inner {
  use super::*;
  use std::collections::HashMap;
  use std::path::PathBuf;

  fn store_path() -> PathBuf {
    let base = dirs::data_local_dir()
      .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("convolios-dev").join("keychain.json")
  }

  fn read_store() -> HashMap<String, String> {
    let p = store_path();
    match std::fs::read_to_string(&p) {
      Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
      Err(_) => HashMap::new(),
    }
  }

  fn write_store(store: &HashMap<String, String>) -> Result<(), String> {
    let p = store_path();
    if let Some(parent) = p.parent() {
      std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let json = serde_json::to_string(store).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(&p, json).map_err(|e| format!("write: {e}"))
  }

  pub fn set_secret(
    provider: &str,
    supabase_user_id: &str,
    account_id: &str,
    secret: &str,
  ) -> Result<(), String> {
    let key = account_key(provider, supabase_user_id, account_id);
    let mut store = read_store();
    store.insert(key, secret.to_string());
    write_store(&store)
  }

  pub fn get_secret(
    provider: &str,
    supabase_user_id: &str,
    account_id: &str,
  ) -> Result<Option<String>, String> {
    let key = account_key(provider, supabase_user_id, account_id);
    let store = read_store();
    Ok(store.get(&key).cloned())
  }

  pub fn delete_secret(
    provider: &str,
    supabase_user_id: &str,
    account_id: &str,
  ) -> Result<(), String> {
    let key = account_key(provider, supabase_user_id, account_id);
    let mut store = read_store();
    store.remove(&key);
    write_store(&store)
  }
}

pub use inner::*;

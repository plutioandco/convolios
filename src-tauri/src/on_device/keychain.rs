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

use keyring::Entry;

use super::KEYCHAIN_SERVICE;

fn account_key(provider: &str, supabase_user_id: &str, account_id: &str) -> String {
  format!("{provider}|{supabase_user_id}|{account_id}")
}

fn entry(provider: &str, supabase_user_id: &str, account_id: &str) -> Result<Entry, String> {
  let user = account_key(provider, supabase_user_id, account_id);
  Entry::new(KEYCHAIN_SERVICE, &user).map_err(|e| format!("keychain entry: {e}"))
}

/// Store an opaque secret blob (typically a JSON-encoded cookie jar) under
/// `(provider, supabase_user_id, account_id)`. Overwrites any existing value.
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

/// Read a previously stored secret. Returns `Ok(None)` if no entry exists —
/// this is the normal case the first time an account is connected on a new
/// machine, not an error.
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

/// Delete a secret. No-op if the entry was never created.
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

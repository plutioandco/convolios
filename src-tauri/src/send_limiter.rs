//! Token-bucket rate limiter for outbound provider actions (sends,
//! attachments). Matches Unipile's published per-channel guidance:
//!
//!   https://developer.unipile.com/docs/provider-limits-and-restrictions
//!
//! Two buckets per (account_id, channel) — hourly and daily — must both
//! have >= 1 token for a send to proceed. Tokens refill continuously at
//! `capacity / window_seconds`, so a veteran idle account gets burst
//! tolerance (can reply to a flurry of DMs after hours of silence) while
//! sustained throughput is still capped at the daily average.
//!
//! ## Why token bucket (not sliding window)
//! Industry standard for per-account outbound quotas: O(1) memory per
//! account (two `f64`s + one `Instant`), burst-friendly, matches
//! "10/hr, 100/day" semantics directly via refill rate. See:
//!   - https://blog.arcjet.com/rate-limiting-algorithms-token-bucket-vs-sliding-window-vs-fixed-window/
//!   - https://redis.io/tutorials/howtos/ratelimiting/
//!
//! ## Warm-up tiering
//! Unipile explicitly recommends gradual ramp-up on fresh accounts
//! ("start with low activity levels and gradually increase"). We scale
//! caps by session age:
//!   - 0–24h (Fresh):   30% of base — user sends still allowed (human
//!                      action is legitimate) but gated to prevent an
//!                      enthusiastic onboarding burst on a brand-new session.
//!   - 24–72h (Warming): 30% of base — same caps, gives the account
//!                       another 48h to look "organic" before full throughput.
//!   - 72h+ (Normal):   full Unipile caps.
//!
//! ## State lifetime
//! In-memory only — resets on app restart. For the hourly window this is
//! fine; the daily cap becomes slightly lenient across restarts. Unipile's
//! caps are recommendations (not enforced by Instagram), so this is
//! acceptable.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WarmupTier {
  Fresh,
  Warming,
  Normal,
}

pub fn warmup_tier_from_age_hours(age_hours: i64) -> WarmupTier {
  if age_hours < 24 {
    WarmupTier::Fresh
  } else if age_hours < 72 {
    WarmupTier::Warming
  } else {
    WarmupTier::Normal
  }
}

struct Bucket {
  tokens: f64,
  capacity: f64,
  refill_per_sec: f64,
  last_refill: Instant,
}

impl Bucket {
  fn new(capacity: f64, refill_per_sec: f64) -> Self {
    Self {
      tokens: capacity,
      capacity,
      refill_per_sec,
      last_refill: Instant::now(),
    }
  }

  fn retune(&mut self, capacity: f64, refill_per_sec: f64) {
    self.capacity = capacity;
    self.refill_per_sec = refill_per_sec;
    if self.tokens > capacity {
      self.tokens = capacity;
    }
  }

  fn peek(&self, now: Instant) -> f64 {
    let elapsed = now.duration_since(self.last_refill).as_secs_f64();
    (self.tokens + elapsed * self.refill_per_sec).min(self.capacity)
  }

  fn commit(&mut self, now: Instant, new_tokens: f64) {
    self.tokens = new_tokens;
    self.last_refill = now;
  }
}

pub struct SendLimiter {
  buckets: Mutex<HashMap<String, (Bucket, Bucket)>>,
}

impl SendLimiter {
  pub fn new() -> Self {
    Self {
      buckets: Mutex::new(HashMap::new()),
    }
  }

  /// Check and atomically consume one token from both hourly and daily
  /// buckets for the given (account_id, channel). On over-quota, returns
  /// a stable error code ("rate_limit:<channel>:hourly" or ":daily") that
  /// the frontend maps to a user-facing message.
  ///
  /// Channels with no Unipile-published caps (X DMs, iMessage, email)
  /// pass through without limiting — different providers have different
  /// rules and we don't enforce a made-up one.
  pub fn check_and_consume(
    &self,
    account_id: &str,
    channel: &str,
    tier: WarmupTier,
  ) -> Result<(), String> {
    let Some((hr_cap, day_cap)) = channel_caps(channel, tier) else {
      return Ok(());
    };

    let hr_cap_f = hr_cap as f64;
    let day_cap_f = day_cap as f64;
    let hr_refill = hr_cap_f / 3600.0;
    let day_refill = day_cap_f / 86_400.0;

    let key = format!("{account_id}:{channel}");
    let mut guard = self.buckets.lock();
    let entry = guard.entry(key).or_insert_with(|| {
      (
        Bucket::new(hr_cap_f, hr_refill),
        Bucket::new(day_cap_f, day_refill),
      )
    });
    entry.0.retune(hr_cap_f, hr_refill);
    entry.1.retune(day_cap_f, day_refill);

    let now = Instant::now();
    let hr_tokens = entry.0.peek(now);
    let day_tokens = entry.1.peek(now);

    if hr_tokens < 1.0 {
      return Err(format!("rate_limit:{channel}:hourly"));
    }
    if day_tokens < 1.0 {
      return Err(format!("rate_limit:{channel}:daily"));
    }

    entry.0.commit(now, hr_tokens - 1.0);
    entry.1.commit(now, day_tokens - 1.0);
    Ok(())
  }
}

/// Per-channel (hourly, daily) caps from Unipile docs, scaled by warm-up tier.
/// Fresh and Warming tiers share the same 30% throttle to keep the first 72h
/// safe for session reputation. Channels not listed here return None (no cap).
fn channel_caps(channel: &str, tier: WarmupTier) -> Option<(u32, u32)> {
  let base: (u32, u32) = match channel {
    "instagram" => (10, 100),
    "whatsapp" => (20, 200),
    "linkedin" => (10, 80),
    _ => return None,
  };
  let scale = match tier {
    WarmupTier::Fresh | WarmupTier::Warming => 0.3,
    WarmupTier::Normal => 1.0,
  };
  let hr = ((base.0 as f64) * scale).ceil().max(1.0) as u32;
  let day = ((base.1 as f64) * scale).ceil().max(1.0) as u32;
  Some((hr, day))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn instagram_hourly_blocks_at_11() {
    let l = SendLimiter::new();
    for _ in 0..10 {
      l.check_and_consume("acc1", "instagram", WarmupTier::Normal).unwrap();
    }
    let err = l.check_and_consume("acc1", "instagram", WarmupTier::Normal).unwrap_err();
    assert_eq!(err, "rate_limit:instagram:hourly");
  }

  #[test]
  fn warming_tier_caps_at_3_per_hour() {
    let l = SendLimiter::new();
    for _ in 0..3 {
      l.check_and_consume("acc1", "instagram", WarmupTier::Warming).unwrap();
    }
    assert!(l.check_and_consume("acc1", "instagram", WarmupTier::Warming).is_err());
  }

  #[test]
  fn unlimited_channels_pass_through() {
    let l = SendLimiter::new();
    for _ in 0..1000 {
      l.check_and_consume("acc1", "x", WarmupTier::Normal).unwrap();
    }
  }

  #[test]
  fn tier_age_thresholds() {
    assert_eq!(warmup_tier_from_age_hours(0), WarmupTier::Fresh);
    assert_eq!(warmup_tier_from_age_hours(23), WarmupTier::Fresh);
    assert_eq!(warmup_tier_from_age_hours(24), WarmupTier::Warming);
    assert_eq!(warmup_tier_from_age_hours(71), WarmupTier::Warming);
    assert_eq!(warmup_tier_from_age_hours(72), WarmupTier::Normal);
    assert_eq!(warmup_tier_from_age_hours(1000), WarmupTier::Normal);
  }
}

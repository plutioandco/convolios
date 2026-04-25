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
//! ## Warm-up scaling (7-day curve)
//! Unipile: start low and gradually increase. We use a step curve by
//! session age (Unipile `account.created_at`) instead of 72h on/off clifs:
//!   0–24h → 30% | 24–72h → 50% | 72–120h → 75% | 120–168h → 90% | 7d+ → 100%

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::Instant;

/// Multiplier 0.3..=1.0 for Unipile's published (hour, day) caps.
/// Outside tests, use `warmup_send_scale_from_age_hours` only.
pub type WarmupScale = f64;

/// Gradual 7-day ramp. Values align with "warm up over days" in Unipile
/// provider docs (WhatsApp / Instagram sections).
pub fn warmup_send_scale_from_age_hours(age_hours: i64) -> f64 {
  if age_hours < 24 {
    0.3
  } else if age_hours < 72 {
    0.5
  } else if age_hours < 120 {
    0.75
  } else if age_hours < 168 {
    0.9
  } else {
    1.0
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

  /// `warmup_scale` is 0.3..1.0 from `warmup_send_scale_from_age_hours`.
  pub fn check_and_consume(
    &self,
    account_id: &str,
    channel: &str,
    warmup_scale: f64,
  ) -> Result<(), String> {
    let Some((hr_cap, day_cap)) = channel_caps(channel, warmup_scale) else {
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

/// Per-channel (hourly, daily) caps from Unipile docs, scaled by
/// `warmup_scale` (0.3–1.0 from the 7-day session ramp). Channels with no
/// Unipile-published caps return None (no limit).
fn channel_caps(channel: &str, warmup_scale: f64) -> Option<(u32, u32)> {
  let base: (u32, u32) = match channel {
    "instagram" => (10, 100),
    "whatsapp" => (20, 200),
    "linkedin" => (10, 80),
    _ => return None,
  };
  let scale = warmup_scale.clamp(0.05, 1.0);
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
      l.check_and_consume("acc1", "instagram", 1.0).unwrap();
    }
    let err = l.check_and_consume("acc1", "instagram", 1.0).unwrap_err();
    assert_eq!(err, "rate_limit:instagram:hourly");
  }

  #[test]
  fn scale_point_five_caps_instagram_hourly() {
    let l = SendLimiter::new();
    for _ in 0..5 {
      l.check_and_consume("acc1", "instagram", 0.5).unwrap();
    }
    assert!(l.check_and_consume("acc1", "instagram", 0.5).is_err());
  }

  #[test]
  fn unlimited_channels_pass_through() {
    let l = SendLimiter::new();
    for _ in 0..1000 {
      l.check_and_consume("acc1", "x", 0.3).unwrap();
    }
  }

  #[test]
  fn age_scale_boundaries() {
    assert!((warmup_send_scale_from_age_hours(0) - 0.3).abs() < f64::EPSILON);
    assert!((warmup_send_scale_from_age_hours(30) - 0.5).abs() < f64::EPSILON);
    assert!((warmup_send_scale_from_age_hours(100) - 0.75).abs() < 0.01);
    assert!((warmup_send_scale_from_age_hours(200) - 1.0).abs() < f64::EPSILON);
  }
}

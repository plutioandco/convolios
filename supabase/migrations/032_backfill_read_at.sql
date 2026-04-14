-- One-time fix: mark all existing inbound messages as read.
-- Historical messages were backfilled without read_at because Unipile's `seen`
-- flag is unreliable for historical data. Going forward, the Rust backfill
-- always sets read_at on inbound messages; only webhook-delivered messages
-- start as unread (read_at IS NULL).
UPDATE messages
SET read_at = COALESCE(synced_at, sent_at, now())
WHERE direction = 'inbound'
  AND read_at IS NULL;

-- Supabase Realtime requires REPLICA IDENTITY FULL for filtered subscriptions
-- to include all columns in UPDATE payloads (not just changed columns + PK).
-- Without this, filters like user_id=eq.X won't match on UPDATE events.
ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE connected_accounts REPLICA IDENTITY FULL;

-- Deletion audit log for GDPR erasure proof.
-- Records WHAT was deleted and WHEN, but not the personal data itself.
CREATE TABLE IF NOT EXISTS deletion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'person_deleted', 'account_disconnected', 'message_deleted'
  target_id TEXT NOT NULL,        -- person_id, account_id, or message external_id
  metadata JSONB DEFAULT '{}',   -- optional context (e.g. { "reason": "account_disconnect" })
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE deletion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own deletion logs"
  ON deletion_log FOR SELECT
  USING (user_id = auth.uid()::text);

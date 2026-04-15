-- 044: Message-level flagging ("Action Items").
--
-- flagged_at: non-NULL = flagged for action. Independent of person-level pin.
-- Maps to Gmail star, Outlook flag, IMAP \Flagged.
-- Messaging channels (WhatsApp, Telegram, etc.) are Convolios-only.
-- Email flags sync two-way via Unipile.

-- ─── Schema ───────────────────────────────────────────────────────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS messages_flagged_idx
  ON messages (user_id, flagged_at DESC)
  WHERE flagged_at IS NOT NULL;

-- ─── RLS policy for flagging ─────────────────────────────────────────────────
-- Allow users to update flagged_at on their own messages.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'messages' AND policyname = 'Users can flag own messages'
  ) THEN
    CREATE POLICY "Users can flag own messages" ON messages
      FOR UPDATE
      USING (user_id = auth.uid()::text)
      WITH CHECK (user_id = auth.uid()::text);
  END IF;
END $$;

-- ─── RPCs ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.flag_message(
  p_user_id text,
  p_message_id uuid,
  p_flagged boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;

  UPDATE messages
  SET flagged_at = CASE WHEN p_flagged THEN now() ELSE NULL END
  WHERE id = p_message_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_flagged_messages(p_user_id text)
RETURNS TABLE (
  message_id uuid,
  person_id uuid,
  display_name text,
  avatar_url text,
  channel text,
  direction text,
  body_text text,
  subject text,
  body_html text,
  attachments jsonb,
  sender_name text,
  sent_at timestamptz,
  flagged_at timestamptz,
  external_id text,
  thread_id text,
  deleted boolean
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id AS message_id,
    m.person_id,
    p.display_name,
    p.avatar_url,
    m.channel,
    m.direction,
    m.body_text,
    m.subject,
    m.body_html,
    m.attachments,
    m.sender_name,
    m.sent_at,
    m.flagged_at,
    m.external_id,
    m.thread_id,
    m.deleted
  FROM messages m
  JOIN persons p ON p.id = m.person_id
  WHERE m.user_id = p_user_id
    AND m.flagged_at IS NOT NULL
  ORDER BY m.flagged_at DESC;
$$;

-- ─── Sync helper: batch update flagged_at from external pin data ─────────────

CREATE OR REPLACE FUNCTION public.sync_person_pin(
  p_user_id text,
  p_person_id uuid,
  p_pinned boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE persons
  SET pinned_at = CASE
        WHEN p_pinned AND pinned_at IS NULL THEN now()
        WHEN NOT p_pinned THEN NULL
        ELSE pinned_at
      END,
      updated_at = now()
  WHERE id = p_person_id AND user_id = p_user_id;
END;
$$;

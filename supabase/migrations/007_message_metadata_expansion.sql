-- 007: Expand messages table with all Unipile metadata fields
-- Captures: delivery status, mutations, system events, reply context,
-- provider deep-links, folder origin, email threading, and read tracking.

-- Delivery / mutation flags
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false;

-- System events (group created, missed call, member added, etc.)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_event BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS event_type TEXT;

-- Reply / quote context
ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_text TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_sender TEXT;

-- Provider deep-link IDs (construct "open in app" URLs)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS chat_provider_id TEXT;

-- Email SMTP threading
ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS smtp_message_id TEXT;

-- Unipile account linkage (may already exist from email handler)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS unipile_account_id TEXT;

-- Folder of origin (IG Primary/General, LI Focused/Other, WA Archived)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS folder TEXT;

-- Unread tracking: NULL = unread, timestamp = when user opened the conversation
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- Indexes for new query patterns
CREATE INDEX IF NOT EXISTS messages_unread_idx
  ON messages(user_id, person_id, read_at)
  WHERE read_at IS NULL AND direction = 'inbound';

CREATE INDEX IF NOT EXISTS messages_folder_idx
  ON messages(user_id, channel, folder);

CREATE INDEX IF NOT EXISTS messages_provider_id_idx
  ON messages(provider_id) WHERE provider_id IS NOT NULL;

-- Fix C2: identity lookup must be scoped to the owning user.
-- Add a user_id column to identities so we can scope lookups.
-- Backfill from the parent person row.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS user_id TEXT;

UPDATE identities SET user_id = p.user_id
FROM persons p WHERE identities.person_id = p.id AND identities.user_id IS NULL;

CREATE INDEX IF NOT EXISTS identities_user_channel_handle_idx
  ON identities(user_id, channel, handle);

-- Update backfill RPC to scope identity lookup by user_id (fixes C2)
CREATE OR REPLACE FUNCTION public.backfill_find_or_create_person(
  p_user_id text,
  p_channel text,
  p_handle text,
  p_display_name text,
  p_unipile_account_id text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person_id uuid;
  v_identity_id uuid;
BEGIN
  SELECT i.id, i.person_id INTO v_identity_id, v_person_id
  FROM identities i
  JOIN persons p ON p.id = i.person_id
  WHERE i.channel = p_channel
    AND i.handle = p_handle
    AND p.user_id = p_user_id
  LIMIT 1;

  IF v_person_id IS NOT NULL THEN
    IF p_display_name IS NOT NULL AND p_display_name != 'Unknown' THEN
      UPDATE persons SET display_name = p_display_name, updated_at = now()
      WHERE id = v_person_id AND display_name = 'Unknown';
    END IF;
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  INSERT INTO persons (user_id, display_name)
  VALUES (p_user_id, p_display_name)
  RETURNING id INTO v_person_id;

  INSERT INTO identities (person_id, channel, handle, display_name, unipile_account_id, user_id)
  VALUES (v_person_id, p_channel, p_handle, p_display_name, p_unipile_account_id, p_user_id)
  RETURNING id INTO v_identity_id;

  RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
END;
$$;

-- Updated conversations RPC: real unread count + subject + prev inbound preview
DROP FUNCTION IF EXISTS public.get_conversations(text);

CREATE OR REPLACE FUNCTION public.get_conversations(p_user_id text)
RETURNS TABLE (
  person_id uuid,
  display_name text,
  avatar_url text,
  notes text,
  ai_summary text,
  last_message_id uuid,
  last_channel text,
  last_direction text,
  last_message_type text,
  last_body_text text,
  last_subject text,
  last_attachments jsonb,
  last_sender_name text,
  last_sent_at timestamptz,
  last_triage text,
  last_thread_id text,
  last_external_id text,
  prev_inbound_body text,
  prev_inbound_sender text,
  unread_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id,
      m.id AS last_message_id,
      m.channel AS last_channel,
      m.direction AS last_direction,
      m.message_type AS last_message_type,
      m.body_text AS last_body_text,
      m.subject AS last_subject,
      m.attachments AS last_attachments,
      m.sender_name AS last_sender_name,
      m.sent_at AS last_sent_at,
      m.triage AS last_triage,
      m.thread_id AS last_thread_id,
      m.external_id AS last_external_id
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.person_id IS NOT NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  prev_inbound AS (
    SELECT DISTINCT ON (l.person_id)
      l.person_id,
      m.body_text AS prev_inbound_body,
      m.sender_name AS prev_inbound_sender
    FROM latest l
    JOIN LATERAL (
      SELECT mi.body_text, mi.sender_name
      FROM messages mi
      WHERE mi.user_id = p_user_id
        AND mi.person_id = l.person_id
        AND mi.direction = 'inbound'
        AND mi.hidden IS NOT TRUE
        AND mi.deleted IS NOT TRUE
      ORDER BY mi.sent_at DESC
      LIMIT 1
    ) m ON true
    WHERE l.last_direction = 'outbound'
  ),
  counts AS (
    SELECT m.person_id, COUNT(*) AS unread_count
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.read_at IS NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
      AND m.person_id IS NOT NULL
    GROUP BY m.person_id
  )
  SELECT
    p.id AS person_id,
    p.display_name,
    p.avatar_url,
    p.notes,
    p.ai_summary,
    l.last_message_id,
    l.last_channel,
    l.last_direction,
    l.last_message_type,
    l.last_body_text,
    l.last_subject,
    l.last_attachments,
    l.last_sender_name,
    l.last_sent_at,
    l.last_triage,
    l.last_thread_id,
    l.last_external_id,
    pi.prev_inbound_body,
    pi.prev_inbound_sender,
    COALESCE(c.unread_count, 0) AS unread_count
  FROM latest l
  JOIN persons p ON p.id = l.person_id
  LEFT JOIN prev_inbound pi ON pi.person_id = l.person_id
  LEFT JOIN counts c ON c.person_id = l.person_id
  ORDER BY l.last_sent_at DESC;
$$;

-- Mark-as-read helper: called when user opens a conversation
CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_user_id text, p_person_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE messages
  SET read_at = now()
  WHERE user_id = p_user_id
    AND person_id = p_person_id
    AND direction = 'inbound'
    AND read_at IS NULL;
$$;

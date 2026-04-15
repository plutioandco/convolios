-- 042: Mark-as-unread and pin-conversation support.
--
-- marked_unread: reminder flag (does NOT revert read receipts). Cleared when
--   the user opens the thread. Separate from messages.read_at.
-- pinned_at: non-NULL = pinned. Pinned conversations sort to the top of the
--   inbox, ordered among themselves by pin time (newest pin first).

-- ─── Schema ───────────────────────────────────────────────────────────────────

ALTER TABLE persons ADD COLUMN IF NOT EXISTS marked_unread BOOLEAN DEFAULT FALSE;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- ─── RPCs ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_person_unread(
  p_user_id text,
  p_person_id uuid,
  p_unread boolean
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

  UPDATE persons
  SET marked_unread = p_unread, updated_at = now()
  WHERE id = p_person_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pin_person(
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
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;

  UPDATE persons
  SET pinned_at = CASE WHEN p_pinned THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_person_id AND user_id = p_user_id;
END;
$$;

-- ─── Updated get_conversations ────────────────────────────────────────────────
-- Adds marked_unread + pinned_at to return columns.
-- Sorts pinned conversations first (by pin time DESC), then by last message.

DROP FUNCTION IF EXISTS public.get_conversations(text, text, uuid);

CREATE OR REPLACE FUNCTION public.get_conversations(
  p_user_id text,
  p_status text DEFAULT 'approved',
  p_circle_id uuid DEFAULT NULL
)
RETURNS TABLE (
  person_id uuid,
  display_name text,
  avatar_url text,
  notes text,
  ai_summary text,
  channels text[],
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
  last_seen boolean,
  last_delivered boolean,
  prev_inbound_body text,
  prev_inbound_sender text,
  unread_count bigint,
  marked_unread boolean,
  pinned_at timestamptz
)
LANGUAGE sql
STABLE
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
      m.external_id AS last_external_id,
      m.seen AS last_seen,
      m.delivered AS last_delivered
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.person_id IS NOT NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
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
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = p.id) AS channels,
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
    l.last_seen,
    l.last_delivered,
    NULL::text AS prev_inbound_body,
    NULL::text AS prev_inbound_sender,
    COALESCE(c.unread_count, 0) AS unread_count,
    COALESCE(p.marked_unread, false) AS marked_unread,
    p.pinned_at
  FROM latest l
  JOIN persons p ON p.id = l.person_id
  LEFT JOIN counts c ON c.person_id = l.person_id
  WHERE p.status = p_status
    AND (p_circle_id IS NULL OR EXISTS (
      SELECT 1 FROM circle_members cm
      WHERE cm.person_id = p.id AND cm.circle_id = p_circle_id
    ))
  ORDER BY p.pinned_at IS NULL, p.pinned_at DESC, l.last_sent_at DESC;
$$;

-- ─── Helper for Tauri chat_action ─────────────────────────────────────────────
-- Returns distinct thread_ids per person so the Rust backend can sync
-- pin/unread status to each platform via Unipile.

CREATE OR REPLACE FUNCTION public.get_person_threads(
  p_user_id text,
  p_person_id uuid
)
RETURNS TABLE (
  thread_id text,
  channel text,
  unipile_account_id text
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (m.thread_id)
    m.thread_id,
    m.channel,
    m.unipile_account_id
  FROM messages m
  WHERE m.user_id = p_user_id
    AND m.person_id = p_person_id
    AND m.thread_id IS NOT NULL
  ORDER BY m.thread_id, m.sent_at DESC;
$$;

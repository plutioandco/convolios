-- 050: Schema hardening — constraints, auth guards, indexes, external_id scoping.
--
-- Phase 3 of the hardening plan. Must be applied BEFORE Phase 4 backend changes
-- (which updates onConflict: "user_id,external_id" in edge functions).

-- ─── 1. User-scoped external_id ──────────────────────────────────────────────
-- Global UNIQUE on external_id is wrong for multi-account: two users could
-- receive the same forwarded email with the same Unipile message ID.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_external_id_key;
DROP INDEX IF EXISTS messages_external_id_key;

CREATE UNIQUE INDEX messages_external_id_user_idx
  ON messages(user_id, external_id) WHERE external_id IS NOT NULL;

-- ─── 2. OAuth state TTL cleanup ──────────────────────────────────────────────
-- x_oauth_state rows are never cleaned up. Purge anything older than 1 hour.

DELETE FROM x_oauth_state WHERE created_at < now() - interval '1 hour';

-- ─── 3. RPC auth hardening ───────────────────────────────────────────────────
-- get_conversations: add auth.uid() filter to the WHERE clause (SQL function).
-- This silently returns empty for spoofed p_user_id instead of raising, which
-- is acceptable — it matches the RLS pattern and avoids converting the complex
-- CTE to plpgsql.

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
      AND m.user_id = coalesce(auth.uid()::text, '')
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

-- search_messages: convert to plpgsql for explicit auth check
CREATE OR REPLACE FUNCTION public.search_messages(
  p_user_id text,
  p_query text,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  message_id uuid,
  person_id uuid,
  display_name text,
  avatar_url text,
  channel text,
  body_text text,
  subject text,
  sent_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;

  RETURN QUERY
  SELECT
    m.id AS message_id,
    m.person_id,
    p.display_name,
    p.avatar_url,
    m.channel,
    m.body_text,
    m.subject,
    m.sent_at
  FROM messages m
  JOIN persons p ON p.id = m.person_id
  WHERE m.user_id = p_user_id
    AND m.person_id IS NOT NULL
    AND m.hidden IS NOT TRUE
    AND m.deleted IS NOT TRUE
    AND (
      m.body_text ILIKE '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      OR m.subject ILIKE '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
  ORDER BY m.sent_at DESC
  LIMIT p_limit;
END;
$$;

-- get_flagged_messages: convert to plpgsql for explicit auth check
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;

  RETURN QUERY
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
    AND m.hidden IS NOT TRUE
    AND m.deleted IS NOT TRUE
  ORDER BY m.flagged_at DESC;
END;
$$;

-- ─── 4. Add deleted_at timestamp for soft-delete audit trail ─────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ─── 5. CHECK constraints ────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT messages_direction_check
    CHECK (direction IN ('inbound', 'outbound'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT messages_triage_check
    CHECK (triage IN ('urgent', 'human', 'newsletter', 'notification', 'noise', 'unclassified'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE persons ADD CONSTRAINT persons_status_check
    CHECK (status IN ('pending', 'approved', 'blocked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── 6. Partial index for active messages ────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_active
  ON messages(person_id, sent_at DESC)
  WHERE deleted IS NOT TRUE AND hidden IS NOT TRUE;

-- ─── 7. Minor fixes ─────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE persons ADD CONSTRAINT persons_notes_length_check
    CHECK (length(notes) <= 10000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

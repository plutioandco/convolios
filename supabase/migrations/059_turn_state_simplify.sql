-- 058: Turn-state simplification + snooze + done removal.
--
-- Product decision: the inbox only has four views — my_turn, their_turn,
-- all, and gate (scanner). "dropped" (inbound >=2d), "stalled" (outbound
-- >=3d), "done" (explicitly marked), and "snoozed" (scheduled mute) are
-- all dropped. my_turn / their_turn are now pure direction-of-last-message
-- with no time thresholds.
--
-- This migration supersedes migrations 053, 054 and 057. It drops every
-- surface those introduced (table, columns, triggers, RPCs, grants) and
-- rebuilds get_conversations + get_state_counts with the simplified shape.

-- ─── 1. Drop snooze surface (from 057) ──────────────────────────────────────
DROP TRIGGER  IF EXISTS trg_unsnooze_on_inbound ON messages;
DROP FUNCTION IF EXISTS public.unsnooze_on_inbound();
DROP FUNCTION IF EXISTS public.snooze_person(uuid, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.unsnooze_person(uuid);
DROP TABLE    IF EXISTS snoozes;

-- ─── 2. Drop done surface (from 053) ────────────────────────────────────────
DROP TRIGGER  IF EXISTS trg_clear_done_on_inbound ON messages;
DROP FUNCTION IF EXISTS public.clear_done_on_inbound();
DROP FUNCTION IF EXISTS public.mark_person_done(uuid);
DROP FUNCTION IF EXISTS public.unmark_person_done(uuid);
DROP INDEX    IF EXISTS idx_persons_done_at;
ALTER TABLE persons DROP COLUMN IF EXISTS done_at;

-- ─── 3. Rebuild get_conversations — direction-only turn_state ───────────────
-- Drop every prior signature (053, 057) before recreating.
DROP FUNCTION IF EXISTS public.get_conversations(text, text, uuid);
DROP FUNCTION IF EXISTS public.get_conversations(text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.get_conversations(
  p_user_id text,
  p_status text DEFAULT 'approved',
  p_circle_id uuid DEFAULT NULL,
  p_state text DEFAULT NULL
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
  pinned_at timestamptz,
  turn_state text
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id,
      m.id           AS last_message_id,
      m.channel      AS last_channel,
      m.direction    AS last_direction,
      m.message_type AS last_message_type,
      m.body_text    AS last_body_text,
      m.subject      AS last_subject,
      m.attachments  AS last_attachments,
      m.sender_name  AS last_sender_name,
      m.sent_at      AS last_sent_at,
      m.triage       AS last_triage,
      m.thread_id    AS last_thread_id,
      m.external_id  AS last_external_id,
      m.seen         AS last_seen,
      m.delivered    AS last_delivered
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.user_id = coalesce(auth.uid()::text, '')
      AND m.person_id IS NOT NULL
      AND m.hidden  IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  counts AS (
    SELECT m.person_id, COUNT(*) AS unread_count
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.read_at IS NULL
      AND m.hidden  IS NOT TRUE
      AND m.deleted IS NOT TRUE
      AND m.person_id IS NOT NULL
    GROUP BY m.person_id
  ),
  rows AS (
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
      p.pinned_at,
      CASE
        WHEN p.status = 'pending'          THEN 'gate'
        WHEN l.last_direction = 'inbound'  THEN 'my_turn'
        WHEN l.last_direction = 'outbound' THEN 'their_turn'
        ELSE 'their_turn'
      END AS turn_state,
      p.status AS person_status
    FROM persons p
    LEFT JOIN latest l ON l.person_id = p.id
    LEFT JOIN counts c ON c.person_id = p.id
  )
  SELECT
    r.person_id, r.display_name, r.avatar_url, r.notes, r.ai_summary,
    r.channels, r.last_message_id, r.last_channel, r.last_direction,
    r.last_message_type, r.last_body_text, r.last_subject, r.last_attachments,
    r.last_sender_name, r.last_sent_at, r.last_triage, r.last_thread_id,
    r.last_external_id, r.last_seen, r.last_delivered,
    r.prev_inbound_body, r.prev_inbound_sender,
    r.unread_count, r.marked_unread, r.pinned_at,
    r.turn_state
  FROM rows r
  WHERE r.last_message_id IS NOT NULL
    AND (
          (p_state = 'gate' AND r.person_status = 'pending')
       OR (p_state IS NULL            AND r.person_status = p_status)
       OR (p_state IS NOT NULL
           AND p_state <> 'gate'
           AND r.person_status = p_status
           AND r.turn_state = p_state)
    )
    AND (p_circle_id IS NULL OR EXISTS (
      SELECT 1 FROM circle_members cm
      WHERE cm.person_id = r.person_id AND cm.circle_id = p_circle_id
    ))
  ORDER BY r.pinned_at IS NULL, r.pinned_at DESC, r.last_sent_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_conversations(text, text, uuid, text) TO authenticated;

-- ─── 4. Rebuild get_state_counts — my_turn / their_turn / gate only ────────
CREATE OR REPLACE FUNCTION public.get_state_counts(p_user_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id, m.direction AS last_direction
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.user_id = coalesce(auth.uid()::text, '')
      AND m.person_id IS NOT NULL
      AND m.hidden  IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  rows AS (
    SELECT
      CASE
        WHEN p.status = 'pending'          THEN 'gate'
        WHEN l.last_direction = 'inbound'  THEN 'my_turn'
        WHEN l.last_direction = 'outbound' THEN 'their_turn'
        ELSE 'their_turn'
      END AS state,
      p.status AS person_status,
      l.person_id AS latest_person_id
    FROM persons p
    LEFT JOIN latest l ON l.person_id = p.id
    WHERE p.user_id = p_user_id
  )
  SELECT jsonb_build_object(
    'my_turn',    COUNT(*) FILTER (WHERE state = 'my_turn'    AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'their_turn', COUNT(*) FILTER (WHERE state = 'their_turn' AND person_status = 'approved' AND latest_person_id IS NOT NULL),
    'gate',       COUNT(*) FILTER (WHERE person_status = 'pending' AND latest_person_id IS NOT NULL)
  )
  FROM rows;
$$;

GRANT EXECUTE ON FUNCTION public.get_state_counts(text) TO authenticated;

-- 020: Re-include avatar_url in get_conversations RPC.
-- Avatars are now short Supabase Storage URLs (~100 chars), not base64 blobs.
-- Including them in the RPC eliminates a separate persons query round-trip.

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
  last_seen boolean,
  last_delivered boolean,
  prev_inbound_body text,
  prev_inbound_sender text,
  unread_count bigint
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
    COALESCE(c.unread_count, 0) AS unread_count
  FROM latest l
  JOIN persons p ON p.id = l.person_id
  LEFT JOIN counts c ON c.person_id = l.person_id
  ORDER BY l.last_sent_at DESC;
$$;

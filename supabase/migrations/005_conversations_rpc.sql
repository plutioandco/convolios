-- Conversation list RPC: returns one row per person with their latest message.
-- Avatars are excluded to avoid serializing ~25MB of base64 data URIs;
-- the frontend batch-loads them separately after the list renders.

DROP FUNCTION IF EXISTS public.get_conversations(text);

CREATE OR REPLACE FUNCTION public.get_conversations(p_user_id text)
RETURNS TABLE (
  person_id uuid,
  display_name text,
  notes text,
  ai_summary text,
  last_message_id uuid,
  last_channel text,
  last_direction text,
  last_message_type text,
  last_body_text text,
  last_attachments jsonb,
  last_sender_name text,
  last_sent_at timestamptz,
  last_triage text,
  last_thread_id text,
  last_external_id text,
  last_subject text,
  prev_inbound_body text,
  prev_inbound_sender text,
  inbound_count bigint
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
      m.attachments AS last_attachments,
      m.sender_name AS last_sender_name,
      m.sent_at AS last_sent_at,
      m.triage AS last_triage,
      m.thread_id AS last_thread_id,
      m.external_id AS last_external_id,
      m.subject AS last_subject
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.person_id IS NOT NULL
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
      ORDER BY mi.sent_at DESC
      LIMIT 1
    ) m ON true
    WHERE l.last_direction = 'outbound'
  ),
  counts AS (
    SELECT m.person_id, COUNT(*) AS inbound_count
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.triage != 'noise'
      AND m.person_id IS NOT NULL
    GROUP BY m.person_id
  )
  SELECT
    p.id AS person_id,
    p.display_name,
    p.notes,
    p.ai_summary,
    l.last_message_id,
    l.last_channel,
    l.last_direction,
    l.last_message_type,
    l.last_body_text,
    l.last_attachments,
    l.last_sender_name,
    l.last_sent_at,
    l.last_triage,
    l.last_thread_id,
    l.last_external_id,
    l.last_subject,
    pi.prev_inbound_body,
    pi.prev_inbound_sender,
    COALESCE(c.inbound_count, 0) AS inbound_count
  FROM latest l
  JOIN persons p ON p.id = l.person_id
  LEFT JOIN prev_inbound pi ON pi.person_id = l.person_id
  LEFT JOIN counts c ON c.person_id = l.person_id
  ORDER BY l.last_sent_at DESC;
$$;

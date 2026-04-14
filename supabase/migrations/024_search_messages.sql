-- 024: Full-text search across messages for Cmd+K.
-- Returns up to 20 matching messages with person context.

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
LANGUAGE sql
STABLE
AS $$
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
$$;

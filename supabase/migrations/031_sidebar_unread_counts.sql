-- Per-channel and per-circle unread counts in a single roundtrip.
-- Returns: { "channels": { "whatsapp": 5, ... }, "circles": { "<uuid>": 2, ... }, "total": 8 }
CREATE OR REPLACE FUNCTION public.get_sidebar_unread(p_user_id text)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  WITH unread_msgs AS (
    SELECT m.channel, m.person_id
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.read_at IS NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
      AND m.person_id IS NOT NULL
  ),
  channel_counts AS (
    SELECT channel, COUNT(*) AS cnt
    FROM unread_msgs
    GROUP BY channel
  ),
  person_counts AS (
    SELECT person_id, COUNT(*) AS cnt
    FROM unread_msgs
    GROUP BY person_id
  ),
  circle_counts AS (
    SELECT cm.circle_id, COALESCE(SUM(pc.cnt), 0) AS cnt
    FROM circle_members cm
    JOIN circles c ON c.id = cm.circle_id AND c.user_id = p_user_id
    LEFT JOIN person_counts pc ON pc.person_id = cm.person_id
    GROUP BY cm.circle_id
  )
  SELECT jsonb_build_object(
    'channels', (SELECT COALESCE(jsonb_object_agg(channel, cnt), '{}'::jsonb) FROM channel_counts),
    'circles',  (SELECT COALESCE(jsonb_object_agg(circle_id, cnt), '{}'::jsonb) FROM circle_counts),
    'total',    (SELECT COALESCE(SUM(cnt), 0) FROM channel_counts)
  )
$$;

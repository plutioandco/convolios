-- 061: Align get_sidebar_unread with the rest of the inbox counters.
--
-- get_sidebar_unread was the only counter RPC that did NOT filter by
-- persons.status = 'approved'. Result: channels and the "All" total lit up
-- with unread numbers that counted pending (Gate) persons, so the user would
-- see e.g. "Messenger 92" in the sidebar but "No conversations." in the
-- list — the 92 all belonged to a pending sender stuck in Gate.
--
-- Every sibling RPC (get_conversations, get_state_counts) already scopes by
-- persons.status. This migration brings get_sidebar_unread in line, so the
-- sidebar numbers match what the user can actually see in each view. Pending
-- persons are not hidden — they're already counted under Library → Gate via
-- get_state_counts, so nothing disappears from the UI.

CREATE OR REPLACE FUNCTION public.get_sidebar_unread(p_user_id text)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  WITH unread_msgs AS (
    SELECT m.channel, m.person_id
    FROM messages m
    JOIN persons p
      ON p.id = m.person_id
     AND p.user_id = m.user_id
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.read_at IS NULL
      AND m.hidden  IS NOT TRUE
      AND m.deleted IS NOT TRUE
      AND m.person_id IS NOT NULL
      AND p.status = 'approved'
  ),
  channel_counts AS (
    SELECT channel, COUNT(*) AS cnt FROM unread_msgs GROUP BY channel
  ),
  person_counts AS (
    SELECT person_id, COUNT(*) AS cnt FROM unread_msgs GROUP BY person_id
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

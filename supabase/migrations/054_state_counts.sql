-- 054: State counts RPC.
--
-- Returns per-state conversation counts so the new state-primary sidebar can
-- show badges without duplicating the turn-state derivation logic client-side.
-- Shape matches get_sidebar_unread: one JSONB payload so one query updates all
-- six state badges atomically.

CREATE OR REPLACE FUNCTION public.get_state_counts(p_user_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id,
      m.direction AS last_direction,
      m.sent_at   AS last_sent_at
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.user_id = coalesce(auth.uid()::text, '')
      AND m.person_id IS NOT NULL
      AND m.hidden  IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  states AS (
    SELECT
      CASE
        WHEN p.status = 'pending' THEN 'gate'
        WHEN p.done_at IS NOT NULL THEN 'done'
        WHEN l.last_direction = 'inbound'  AND l.last_sent_at >= now() - interval '2 days' THEN 'my_turn'
        WHEN l.last_direction = 'inbound'  THEN 'dropped'
        WHEN l.last_direction = 'outbound' AND l.last_sent_at >= now() - interval '3 days' THEN 'their_turn'
        WHEN l.last_direction = 'outbound' THEN 'stalled'
        ELSE 'their_turn'
      END AS state
    FROM persons p
    LEFT JOIN latest l ON l.person_id = p.id
    WHERE p.user_id = p_user_id
      AND l.person_id IS NOT NULL
      AND (p.status = 'approved' OR p.status = 'pending')
  )
  SELECT jsonb_build_object(
    'my_turn',    COUNT(*) FILTER (WHERE state = 'my_turn'),
    'their_turn', COUNT(*) FILTER (WHERE state = 'their_turn'),
    'stalled',    COUNT(*) FILTER (WHERE state = 'stalled'),
    'dropped',    COUNT(*) FILTER (WHERE state = 'dropped'),
    'done',       COUNT(*) FILTER (WHERE state = 'done'),
    'gate',       COUNT(*) FILTER (WHERE state = 'gate')
  )
  FROM states;
$$;

GRANT EXECUTE ON FUNCTION public.get_state_counts(text) TO authenticated;

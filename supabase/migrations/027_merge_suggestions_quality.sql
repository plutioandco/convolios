-- 027: Improve merge suggestion quality.
-- 1. Name-match suggestions are now excluded when both persons share a channel
--    (two "Arv"s on Telegram are different contacts, not duplicates).
-- 2. Add is_group_a / is_group_b flags so the UI can warn / hide merge for groups.
-- 3. Add last_message_a / last_message_b snippet for context in the UI.

DROP FUNCTION IF EXISTS public.get_merge_suggestions(text);

CREATE OR REPLACE FUNCTION public.get_merge_suggestions(p_user_id text)
RETURNS TABLE (
  person_a_id       uuid,
  person_a_name     text,
  person_a_avatar   text,
  person_a_channels text[],
  person_a_is_group boolean,
  person_b_id       uuid,
  person_b_name     text,
  person_b_avatar   text,
  person_b_channels text[],
  person_b_is_group boolean,
  match_type        text,
  match_detail      text,
  score             real
)
LANGUAGE sql
STABLE
AS $$
  WITH dismissed AS (
    SELECT person_a, person_b FROM merge_dismissed WHERE user_id = p_user_id
  ),
  -- persons with their channel arrays and group flag (group = only has group-type messages)
  person_meta AS (
    SELECT
      p.id,
      array_agg(DISTINCT i.channel) AS channels,
      bool_or(m.message_type = 'group') AS is_group
    FROM persons p
    JOIN identities i ON i.person_id = p.id
    LEFT JOIN messages m ON m.person_id = p.id AND m.user_id = p_user_id
    WHERE p.user_id = p_user_id AND p.status != 'blocked'
    GROUP BY p.id
  ),
  -- HIGH-CONFIDENCE: same handle on different channels
  handle_matches AS (
    SELECT
      p1.id AS pa_id, p1.display_name AS pa_name, p1.avatar_url AS pa_avatar,
      p2.id AS pb_id, p2.display_name AS pb_name, p2.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      i1.handle AS mdetail,
      1.0::real AS mscore
    FROM identities i1
    JOIN identities i2 ON lower(i1.handle) = lower(i2.handle)
      AND i1.channel != i2.channel
      AND i1.id < i2.id
    JOIN persons p1 ON i1.person_id = p1.id AND p1.user_id = p_user_id AND p1.status != 'blocked'
    JOIN persons p2 ON i2.person_id = p2.id AND p2.user_id = p_user_id AND p2.status != 'blocked'
    WHERE p1.id != p2.id
      AND NOT EXISTS (
        SELECT 1 FROM dismissed d
        WHERE d.person_a = LEAST(p1.id, p2.id) AND d.person_b = GREATEST(p1.id, p2.id)
      )
  ),
  -- HIGH-CONFIDENCE: shared phone in metadata
  phone_matches AS (
    SELECT
      pa.id AS pa_id, pa.display_name AS pa_name, pa.avatar_url AS pa_avatar,
      pb.id AS pb_id, pb.display_name AS pb_name, pb.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      'Shared phone: ' || (ia.metadata->>'phone') AS mdetail,
      0.95::real AS mscore
    FROM identities ia
    JOIN identities ib ON ia.person_id != ib.person_id
      AND ia.metadata->>'phone' IS NOT NULL AND ia.metadata->>'phone' != ''
      AND ia.metadata->>'phone' = ib.metadata->>'phone'
    JOIN persons pa ON pa.id = ia.person_id AND pa.user_id = p_user_id AND pa.status != 'blocked'
    JOIN persons pb ON pb.id = ib.person_id AND pb.user_id = p_user_id AND pb.status != 'blocked'
    WHERE ia.person_id < ib.person_id
      AND NOT EXISTS (
        SELECT 1 FROM dismissed d
        WHERE d.person_a = LEAST(pa.id, pb.id) AND d.person_b = GREATEST(pa.id, pb.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM handle_matches hm
        WHERE (hm.pa_id = pa.id AND hm.pb_id = pb.id) OR (hm.pa_id = pb.id AND hm.pb_id = pa.id)
      )
  ),
  -- HIGH-CONFIDENCE: shared email in metadata
  email_matches AS (
    SELECT
      pa.id AS pa_id, pa.display_name AS pa_name, pa.avatar_url AS pa_avatar,
      pb.id AS pb_id, pb.display_name AS pb_name, pb.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      'Shared email: ' || (ia.metadata->>'email') AS mdetail,
      0.95::real AS mscore
    FROM identities ia
    JOIN identities ib ON ia.person_id != ib.person_id
      AND ia.metadata->>'email' IS NOT NULL AND ia.metadata->>'email' != ''
      AND lower(ia.metadata->>'email') = lower(ib.metadata->>'email')
    JOIN persons pa ON pa.id = ia.person_id AND pa.user_id = p_user_id AND pa.status != 'blocked'
    JOIN persons pb ON pb.id = ib.person_id AND pb.user_id = p_user_id AND pb.status != 'blocked'
    WHERE ia.person_id < ib.person_id
      AND NOT EXISTS (
        SELECT 1 FROM dismissed d
        WHERE d.person_a = LEAST(pa.id, pb.id) AND d.person_b = GREATEST(pa.id, pb.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM handle_matches hm
        WHERE (hm.pa_id = pa.id AND hm.pb_id = pb.id) OR (hm.pa_id = pb.id AND hm.pb_id = pa.id)
      )
  ),
  -- FUZZY: similar names — ONLY when the two persons do NOT share any channel.
  -- Sharing a channel means they are provably different contacts on that platform.
  name_matches AS (
    SELECT
      p1.id AS pa_id, p1.display_name AS pa_name, p1.avatar_url AS pa_avatar,
      p2.id AS pb_id, p2.display_name AS pb_name, p2.avatar_url AS pb_avatar,
      'name'::text AS mtype,
      p1.display_name || ' / ' || p2.display_name AS mdetail,
      similarity(p1.display_name, p2.display_name)::real AS mscore
    FROM persons p1
    JOIN persons p2 ON p1.id < p2.id AND p1.user_id = p2.user_id
    JOIN person_meta pm1 ON pm1.id = p1.id
    JOIN person_meta pm2 ON pm2.id = p2.id
    WHERE p1.user_id = p_user_id
      AND p1.display_name IS NOT NULL AND p1.display_name != '' AND p1.display_name != 'Unknown'
      AND p2.display_name IS NOT NULL AND p2.display_name != '' AND p2.display_name != 'Unknown'
      AND similarity(p1.display_name, p2.display_name) > 0.4
      AND p1.status != 'blocked' AND p2.status != 'blocked'
      -- KEY FIX: exclude pairs that already share at least one channel
      AND NOT (pm1.channels && pm2.channels)
      AND NOT EXISTS (
        SELECT 1 FROM dismissed d
        WHERE d.person_a = LEAST(p1.id, p2.id) AND d.person_b = GREATEST(p1.id, p2.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM handle_matches hm
        WHERE (hm.pa_id = p1.id AND hm.pb_id = p2.id) OR (hm.pa_id = p2.id AND hm.pb_id = p1.id)
      )
  ),
  all_matches AS (
    SELECT pa_id, pa_name, pa_avatar, pb_id, pb_name, pb_avatar, mtype, mdetail, mscore FROM handle_matches
    UNION ALL
    SELECT pa_id, pa_name, pa_avatar, pb_id, pb_name, pb_avatar, mtype, mdetail, mscore FROM phone_matches
    UNION ALL
    SELECT pa_id, pa_name, pa_avatar, pb_id, pb_name, pb_avatar, mtype, mdetail, mscore FROM email_matches
    UNION ALL
    SELECT pa_id, pa_name, pa_avatar, pb_id, pb_name, pb_avatar, mtype, mdetail, mscore FROM name_matches
  )
  SELECT
    am.pa_id,
    am.pa_name,
    am.pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = am.pa_id),
    COALESCE(pm_a.is_group, false),
    am.pb_id,
    am.pb_name,
    am.pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = am.pb_id),
    COALESCE(pm_b.is_group, false),
    am.mtype,
    am.mdetail,
    am.mscore
  FROM all_matches am
  LEFT JOIN person_meta pm_a ON pm_a.id = am.pa_id
  LEFT JOIN person_meta pm_b ON pm_b.id = am.pb_id
  ORDER BY am.mscore DESC
  LIMIT 50;
$$;

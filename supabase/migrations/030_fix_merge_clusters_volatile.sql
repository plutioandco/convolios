-- 030: Fix get_merge_clusters — was declared STABLE but uses CREATE TEMP TABLE.
-- Postgres blocks DDL in non-volatile functions. Change to VOLATILE (the default).

CREATE OR REPLACE FUNCTION public.get_merge_clusters(p_user_id text)
RETURNS TABLE (
  cluster_id         text,
  keep_person_id     uuid,
  keep_person_name   text,
  keep_person_avatar text,
  members            jsonb,
  match_type         text,
  match_detail       text,
  score              real
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pairs jsonb;
  v_nodes jsonb;
  v_cluster record;
  i int;
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  CREATE TEMP TABLE _pairs ON COMMIT DROP AS
  SELECT
    LEAST(pa_id, pb_id) AS id_lo,
    GREATEST(pa_id, pb_id) AS id_hi,
    mtype,
    mdetail,
    mscore
  FROM (
    SELECT p1.id AS pa_id, p2.id AS pb_id, 'identifier'::text AS mtype,
           i1.handle AS mdetail, 1.0::real AS mscore
    FROM identities i1
    JOIN identities i2 ON lower(i1.handle) = lower(i2.handle)
      AND i1.channel != i2.channel AND i1.id < i2.id
    JOIN persons p1 ON i1.person_id = p1.id AND p1.user_id = p_user_id AND p1.status != 'blocked'
    JOIN persons p2 ON i2.person_id = p2.id AND p2.user_id = p_user_id AND p2.status != 'blocked'
    WHERE p1.id != p2.id
      AND NOT EXISTS (SELECT 1 FROM merge_dismissed d
        WHERE d.user_id = p_user_id AND d.person_a = LEAST(p1.id,p2.id) AND d.person_b = GREATEST(p1.id,p2.id))
    UNION ALL
    SELECT pa.id, pb.id, 'identifier', 'Shared phone: '||(ia.metadata->>'phone'), 0.95
    FROM identities ia
    JOIN identities ib ON ia.person_id != ib.person_id
      AND ia.metadata->>'phone' IS NOT NULL AND ia.metadata->>'phone' != ''
      AND ia.metadata->>'phone' = ib.metadata->>'phone'
    JOIN persons pa ON pa.id = ia.person_id AND pa.user_id = p_user_id AND pa.status != 'blocked'
    JOIN persons pb ON pb.id = ib.person_id AND pb.user_id = p_user_id AND pb.status != 'blocked'
    WHERE ia.person_id < ib.person_id
      AND NOT EXISTS (SELECT 1 FROM merge_dismissed d
        WHERE d.user_id = p_user_id AND d.person_a = LEAST(pa.id,pb.id) AND d.person_b = GREATEST(pa.id,pb.id))
    UNION ALL
    SELECT pa.id, pb.id, 'identifier', 'Shared email: '||(ia.metadata->>'email'), 0.95
    FROM identities ia
    JOIN identities ib ON ia.person_id != ib.person_id
      AND ia.metadata->>'email' IS NOT NULL AND ia.metadata->>'email' != ''
      AND lower(ia.metadata->>'email') = lower(ib.metadata->>'email')
    JOIN persons pa ON pa.id = ia.person_id AND pa.user_id = p_user_id AND pa.status != 'blocked'
    JOIN persons pb ON pb.id = ib.person_id AND pb.user_id = p_user_id AND pb.status != 'blocked'
    WHERE ia.person_id < ib.person_id
      AND NOT EXISTS (SELECT 1 FROM merge_dismissed d
        WHERE d.user_id = p_user_id AND d.person_a = LEAST(pa.id,pb.id) AND d.person_b = GREATEST(pa.id,pb.id))
    UNION ALL
    SELECT p1.id, p2.id, 'name', p1.display_name||' / '||p2.display_name,
           similarity(p1.display_name, p2.display_name)::real
    FROM persons p1
    JOIN persons p2 ON p1.id < p2.id AND p1.user_id = p2.user_id
    WHERE p1.user_id = p_user_id
      AND p1.display_name NOT IN ('','Unknown') AND p2.display_name NOT IN ('','Unknown')
      AND similarity(p1.display_name, p2.display_name) > 0.4
      AND p1.status != 'blocked' AND p2.status != 'blocked'
      AND NOT (
        (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = p1.id) &&
        (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = p2.id)
      )
      AND NOT EXISTS (SELECT 1 FROM merge_dismissed d
        WHERE d.user_id = p_user_id AND d.person_a = LEAST(p1.id,p2.id) AND d.person_b = GREATEST(p1.id,p2.id))
  ) sub;

  IF NOT EXISTS (SELECT 1 FROM _pairs) THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE _cluster_map ON COMMIT DROP AS
  SELECT DISTINCT id_lo AS person_id, id_lo AS cluster_root FROM _pairs
  UNION
  SELECT DISTINCT id_hi, id_hi FROM _pairs;

  FOR i IN 1..10 LOOP
    UPDATE _cluster_map cm
    SET cluster_root = LEAST(cm.cluster_root, p.id_lo, p.id_hi)
    FROM _pairs p
    WHERE (cm.person_id = p.id_lo OR cm.person_id = p.id_hi)
      AND LEAST(p.id_lo, p.id_hi) < cm.cluster_root;
    EXIT WHEN NOT FOUND;
  END LOOP;

  RETURN QUERY
  WITH cluster_members AS (
    SELECT
      cm.cluster_root,
      cm.person_id,
      p.display_name,
      p.avatar_url,
      bool_or(m.message_type = 'group') AS is_group,
      count(m.id) AS msg_count,
      array_agg(DISTINCT i.channel) AS channels
    FROM _cluster_map cm
    JOIN persons p ON p.id = cm.person_id
    LEFT JOIN messages m ON m.person_id = cm.person_id AND m.user_id = p_user_id
    LEFT JOIN identities i ON i.person_id = cm.person_id
    WHERE p.user_id = p_user_id
    GROUP BY cm.cluster_root, cm.person_id, p.display_name, p.avatar_url
  ),
  cluster_keep AS (
    SELECT DISTINCT ON (cluster_root)
      cluster_root, person_id AS keep_id, display_name AS keep_name, avatar_url AS keep_avatar
    FROM cluster_members
    ORDER BY cluster_root, msg_count DESC
  ),
  cluster_signals AS (
    SELECT DISTINCT ON (LEAST(id_lo, id_hi))
      id_lo, id_hi, mtype, mdetail, mscore
    FROM _pairs
    ORDER BY LEAST(id_lo, id_hi), mscore DESC
  )
  SELECT
    (SELECT string_agg(cm2.person_id::text, '|' ORDER BY cm2.person_id)
     FROM cluster_members cm2 WHERE cm2.cluster_root = ck.cluster_root) AS cluster_id,
    ck.keep_id,
    ck.keep_name,
    ck.keep_avatar,
    (SELECT jsonb_agg(jsonb_build_object(
      'id', cm3.person_id,
      'name', cm3.display_name,
      'avatar', cm3.avatar_url,
      'channels', cm3.channels,
      'is_group', cm3.is_group
    ))
     FROM cluster_members cm3 WHERE cm3.cluster_root = ck.cluster_root) AS members,
    (SELECT mtype FROM cluster_signals cs
     WHERE cs.id_lo = ANY(SELECT person_id FROM cluster_members WHERE cluster_root = ck.cluster_root)
        OR cs.id_hi = ANY(SELECT person_id FROM cluster_members WHERE cluster_root = ck.cluster_root)
     ORDER BY mscore DESC LIMIT 1),
    (SELECT mdetail FROM cluster_signals cs
     WHERE cs.id_lo = ANY(SELECT person_id FROM cluster_members WHERE cluster_root = ck.cluster_root)
        OR cs.id_hi = ANY(SELECT person_id FROM cluster_members WHERE cluster_root = ck.cluster_root)
     ORDER BY mscore DESC LIMIT 1),
    (SELECT mscore FROM cluster_signals cs
     WHERE cs.id_lo = ANY(SELECT person_id FROM cluster_members WHERE cluster_root = ck.cluster_root)
        OR cs.id_hi = ANY(SELECT person_id FROM cluster_members WHERE cluster_root = ck.cluster_root)
     ORDER BY mscore DESC LIMIT 1)
  FROM cluster_keep ck;
END;
$$;

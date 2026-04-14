-- 028: Cluster-based merge suggestions.
-- Instead of showing individual pairs, find all connected components
-- (A matches B, B matches C → show {A, B, C} as one cluster to merge at once).
-- Also adds merge_cluster RPC that merges a list of person IDs into one.

-- RPC: get_merge_clusters — returns groups of persons that should be merged together.
-- Each cluster has a canonical "best" person (most messages) and a list of all members.
CREATE OR REPLACE FUNCTION public.get_merge_clusters(p_user_id text)
RETURNS TABLE (
  cluster_id         text,   -- stable key: sorted UUIDs joined by '|'
  keep_person_id     uuid,   -- suggested person to keep (most messages)
  keep_person_name   text,
  keep_person_avatar text,
  members            jsonb,  -- array of {id, name, avatar, channels, is_group}
  match_type         text,   -- strongest signal in cluster: 'identifier' | 'name'
  match_detail       text,
  score              real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pairs jsonb;
  v_nodes jsonb;
  v_cluster record;
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Step 1: get all matching pairs (re-use get_merge_suggestions logic inline)
  CREATE TEMP TABLE _pairs ON COMMIT DROP AS
  SELECT
    LEAST(pa_id, pb_id) AS id_lo,
    GREATEST(pa_id, pb_id) AS id_hi,
    mtype,
    mdetail,
    mscore
  FROM (
    -- handle matches
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
    -- shared phone
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
    -- shared email
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
    -- similar names (cross-channel only)
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

  -- Step 2: union-find — build clusters by following edges
  -- We iterate: for each pair, assign them the same cluster_id (minimum UUID in cluster)
  CREATE TEMP TABLE _cluster_map ON COMMIT DROP AS
  SELECT DISTINCT id_lo AS person_id, id_lo AS cluster_root FROM _pairs
  UNION
  SELECT DISTINCT id_hi, id_hi FROM _pairs;

  -- Iterative path compression (max 10 iterations handles chains up to 2^10 deep)
  FOR i IN 1..10 LOOP
    UPDATE _cluster_map cm
    SET cluster_root = LEAST(cm.cluster_root, p.id_lo, p.id_hi)
    FROM _pairs p
    WHERE (cm.person_id = p.id_lo OR cm.person_id = p.id_hi)
      AND LEAST(p.id_lo, p.id_hi) < cm.cluster_root;
    EXIT WHEN NOT FOUND;
  END LOOP;

  -- Step 3: for each cluster, pick the keep person (most messages)
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

-- RPC: merge_cluster — merge a list of person IDs into one (the keep_id).
-- Chains merge_persons calls so audit log is complete.
CREATE OR REPLACE FUNCTION public.merge_cluster(
  p_user_id text,
  p_keep_id uuid,
  p_merge_ids uuid[]
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_merged int := 0;
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = p_keep_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Keep person not found';
  END IF;

  FOREACH v_id IN ARRAY p_merge_ids LOOP
    IF v_id = p_keep_id THEN CONTINUE; END IF;
    PERFORM merge_persons(p_user_id, p_keep_id, v_id);
    v_merged := v_merged + 1;
  END LOOP;

  RETURN format('Merged %s persons into %s', v_merged, p_keep_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_merge_clusters(text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.merge_cluster(text, uuid, uuid[]) FROM anon, public;

-- 026: Enrich identities during sync with additional metadata from Unipile.
-- Adds p_metadata parameter to backfill_find_or_create_person to store
-- phone numbers, public identifiers, provider IDs, and other enrichment
-- data in the identities.metadata JSONB column.

CREATE OR REPLACE FUNCTION public.backfill_find_or_create_person(
  p_user_id text,
  p_channel text,
  p_handle text,
  p_display_name text,
  p_unipile_account_id text,
  p_direction text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person_id uuid;
  v_identity_id uuid;
  v_orphan_id uuid;
  v_status text;
BEGIN
  SELECT i.id, i.person_id INTO v_identity_id, v_person_id
  FROM identities i
  JOIN persons p ON p.id = i.person_id
  WHERE i.channel = p_channel
    AND i.handle = p_handle
    AND p.user_id = p_user_id
  LIMIT 1;

  IF v_person_id IS NOT NULL THEN
    IF p_display_name IS NOT NULL AND p_display_name != 'Unknown' THEN
      UPDATE persons SET display_name = p_display_name, updated_at = now()
      WHERE id = v_person_id AND display_name = 'Unknown';
    END IF;
    -- Merge new metadata into existing identity
    IF p_metadata IS NOT NULL AND p_metadata != '{}'::jsonb THEN
      UPDATE identities
      SET metadata = COALESCE(metadata, '{}'::jsonb) || p_metadata
      WHERE id = v_identity_id;
    END IF;
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  v_status := CASE WHEN p_direction = 'inbound' THEN 'pending' ELSE 'approved' END;

  INSERT INTO persons (user_id, display_name, status)
  VALUES (p_user_id, p_display_name, v_status)
  RETURNING id INTO v_person_id;

  v_orphan_id := v_person_id;

  BEGIN
    INSERT INTO identities (person_id, channel, handle, display_name, unipile_account_id, user_id, metadata)
    VALUES (v_person_id, p_channel, p_handle, p_display_name, p_unipile_account_id, p_user_id, COALESCE(p_metadata, '{}'::jsonb))
    RETURNING id INTO v_identity_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT i.id, i.person_id INTO v_identity_id, v_person_id
    FROM identities i WHERE i.channel = p_channel AND i.handle = p_handle
    LIMIT 1;
    IF v_orphan_id != v_person_id THEN
      DELETE FROM persons WHERE id = v_orphan_id;
    END IF;
  END;

  RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
END;
$$;

-- Revoke from frontend roles (service-key only)
-- Drop old overloads first to prevent privilege leaks
DROP FUNCTION IF EXISTS public.backfill_find_or_create_person(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.backfill_find_or_create_person(text, text, text, text, text, text);
REVOKE EXECUTE ON FUNCTION public.backfill_find_or_create_person(text, text, text, text, text, text, jsonb)
  FROM authenticated, anon, public;

-- Also update get_merge_suggestions to consider metadata for higher-quality matches.
-- Shared phone or email in metadata is a strong signal.
-- Preserves handle-based matching from 025 and adds metadata-based matching.
DROP FUNCTION IF EXISTS public.get_merge_suggestions(text);

CREATE OR REPLACE FUNCTION public.get_merge_suggestions(p_user_id text)
RETURNS TABLE (
  person_a_id uuid, person_a_name text, person_a_avatar text, person_a_channels text[],
  person_b_id uuid, person_b_name text, person_b_avatar text, person_b_channels text[],
  match_type text, match_detail text, score real
)
LANGUAGE sql
STABLE
AS $$
  WITH dismissed AS (
    SELECT person_a, person_b FROM merge_dismissed WHERE user_id = p_user_id
  ),
  handle_matches AS (
    SELECT
      p1.id AS pa_id, p1.display_name AS pa_name, p1.avatar_url AS pa_avatar,
      p2.id AS pb_id, p2.display_name AS pb_name, p2.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      i1.handle AS mdetail,
      1.0::real AS mscore
    FROM identities i1
    JOIN identities i2 ON lower(i1.handle) = lower(i2.handle) AND i1.channel != i2.channel AND i1.id < i2.id
    JOIN persons p1 ON i1.person_id = p1.id
    JOIN persons p2 ON i2.person_id = p2.id
    WHERE p1.id != p2.id AND p1.user_id = p_user_id AND p2.user_id = p_user_id
      AND p1.status != 'blocked' AND p2.status != 'blocked'
      AND NOT EXISTS (
        SELECT 1 FROM dismissed d
        WHERE d.person_a = LEAST(p1.id, p2.id) AND d.person_b = GREATEST(p1.id, p2.id)
      )
  ),
  phone_matches AS (
    SELECT
      pa.id AS pa_id, pa.display_name AS pa_name, pa.avatar_url AS pa_avatar,
      pb.id AS pb_id, pb.display_name AS pb_name, pb.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      'Shared phone: ' || (ia.metadata->>'phone') AS mdetail,
      0.95::real AS mscore
    FROM identities ia
    JOIN identities ib ON ia.person_id != ib.person_id
      AND ia.metadata->>'phone' IS NOT NULL
      AND ia.metadata->>'phone' != ''
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
  email_matches AS (
    SELECT
      pa.id AS pa_id, pa.display_name AS pa_name, pa.avatar_url AS pa_avatar,
      pb.id AS pb_id, pb.display_name AS pb_name, pb.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      'Shared email: ' || (ia.metadata->>'email') AS mdetail,
      0.95::real AS mscore
    FROM identities ia
    JOIN identities ib ON ia.person_id != ib.person_id
      AND ia.metadata->>'email' IS NOT NULL
      AND ia.metadata->>'email' != ''
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
  name_matches AS (
    SELECT
      p1.id AS pa_id, p1.display_name AS pa_name, p1.avatar_url AS pa_avatar,
      p2.id AS pb_id, p2.display_name AS pb_name, p2.avatar_url AS pb_avatar,
      'name'::text AS mtype,
      p1.display_name || ' / ' || p2.display_name AS mdetail,
      similarity(p1.display_name, p2.display_name)::real AS mscore
    FROM persons p1
    JOIN persons p2 ON p1.id < p2.id AND p1.user_id = p2.user_id
    WHERE p1.user_id = p_user_id
      AND p1.display_name IS NOT NULL AND p1.display_name != '' AND p1.display_name != 'Unknown'
      AND p2.display_name IS NOT NULL AND p2.display_name != '' AND p2.display_name != 'Unknown'
      AND similarity(p1.display_name, p2.display_name) > 0.4
      AND p1.status != 'blocked' AND p2.status != 'blocked'
      AND NOT EXISTS (
        SELECT 1 FROM dismissed d
        WHERE d.person_a = LEAST(p1.id, p2.id) AND d.person_b = GREATEST(p1.id, p2.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM handle_matches hm
        WHERE (hm.pa_id = p1.id AND hm.pb_id = p2.id) OR (hm.pa_id = p2.id AND hm.pb_id = p1.id)
      )
  )
  SELECT
    pa_id, pa_name, pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pa_id),
    pb_id, pb_name, pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pb_id),
    mtype, mdetail, mscore
  FROM handle_matches
  UNION ALL
  SELECT
    pa_id, pa_name, pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pa_id),
    pb_id, pb_name, pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pb_id),
    mtype, mdetail, mscore
  FROM phone_matches
  UNION ALL
  SELECT
    pa_id, pa_name, pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pa_id),
    pb_id, pb_name, pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pb_id),
    mtype, mdetail, mscore
  FROM email_matches
  UNION ALL
  SELECT
    pa_id, pa_name, pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pa_id),
    pb_id, pb_name, pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pb_id),
    mtype, mdetail, mscore
  FROM name_matches
  ORDER BY mscore DESC
  LIMIT 50;
$$;

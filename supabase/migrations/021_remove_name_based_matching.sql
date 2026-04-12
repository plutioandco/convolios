-- 021: Remove dangerous name-based fallback from backfill_find_or_create_person.
-- The display_name fallback merged different people with the same name on
-- the same channel. Handle-only matching is safer; future merges should be
-- user-confirmed, not automatic.

CREATE OR REPLACE FUNCTION public.backfill_find_or_create_person(
  p_user_id text,
  p_channel text,
  p_handle text,
  p_display_name text,
  p_unipile_account_id text
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
BEGIN
  -- Primary lookup: exact (channel, handle, user_id)
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
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  -- No handle match — create new person + identity
  INSERT INTO persons (user_id, display_name)
  VALUES (p_user_id, p_display_name)
  RETURNING id INTO v_person_id;

  v_orphan_id := v_person_id;

  BEGIN
    INSERT INTO identities (person_id, channel, handle, display_name, unipile_account_id, user_id)
    VALUES (v_person_id, p_channel, p_handle, p_display_name, p_unipile_account_id, p_user_id)
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

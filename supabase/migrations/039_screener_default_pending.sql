-- 039: Default new persons to 'pending' unless explicitly 'outbound'.
-- Previously, NULL p_direction fell through to 'approved', allowing new
-- contacts to bypass the screener on any code path that forgot to pass direction.

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
    IF p_metadata IS NOT NULL AND p_metadata != '{}'::jsonb THEN
      UPDATE identities
      SET metadata = COALESCE(metadata, '{}'::jsonb) || p_metadata
      WHERE id = v_identity_id;
    END IF;
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  v_status := CASE WHEN p_direction = 'outbound' THEN 'approved' ELSE 'pending' END;

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

REVOKE EXECUTE ON FUNCTION public.backfill_find_or_create_person(text, text, text, text, text, text, jsonb)
  FROM authenticated, anon, public;

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
AS $$
DECLARE
  v_person_id uuid;
  v_identity_id uuid;
BEGIN
  SELECT id, person_id INTO v_identity_id, v_person_id
  FROM identities
  WHERE channel = p_channel AND handle = p_handle
  LIMIT 1;

  IF v_person_id IS NOT NULL THEN
    -- Update display_name if it was 'Unknown' and we now have a real name
    IF p_display_name IS NOT NULL AND p_display_name != 'Unknown' THEN
      UPDATE persons SET display_name = p_display_name, updated_at = now()
      WHERE id = v_person_id AND display_name = 'Unknown';
    END IF;
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  INSERT INTO persons (user_id, display_name)
  VALUES (p_user_id, p_display_name)
  RETURNING id INTO v_person_id;

  INSERT INTO identities (person_id, channel, handle, display_name, unipile_account_id)
  VALUES (v_person_id, p_channel, p_handle, p_display_name, p_unipile_account_id)
  RETURNING id INTO v_identity_id;

  RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
END;
$$;

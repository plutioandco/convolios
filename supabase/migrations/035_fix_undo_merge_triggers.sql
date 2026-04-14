-- 035: Fix undo_merge to bypass safeguard triggers + add perf indexes
-- The triggers from 034 block person_id updates, which undo_merge needs.

CREATE OR REPLACE FUNCTION public.undo_merge(p_user_id text, p_merge_log_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log merge_log%ROWTYPE;
  v_new_person_id uuid;
  v_ident record;
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_log FROM merge_log
  WHERE id = p_merge_log_id AND user_id = p_user_id AND undone_at IS NULL;
  IF v_log.id IS NULL THEN
    RAISE EXCEPTION 'Merge log not found or already undone';
  END IF;

  ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

  INSERT INTO persons (user_id, display_name, status)
  VALUES (p_user_id, v_log.merged_person_name, 'approved')
  RETURNING id INTO v_new_person_id;

  FOR v_ident IN SELECT * FROM jsonb_to_recordset(v_log.merged_identities) AS x(id uuid, channel text, handle text)
  LOOP
    UPDATE identities SET person_id = v_new_person_id
    WHERE id = v_ident.id AND person_id = v_log.keep_person_id;
  END LOOP;

  UPDATE messages SET person_id = v_new_person_id
  WHERE person_id = v_log.keep_person_id
    AND identity_id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_log.merged_identities) j);

  UPDATE merge_log SET undone_at = now() WHERE id = p_merge_log_id;

  ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;

  RETURN v_new_person_id;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_send_audit_log_user_created
  ON send_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread_type_person
  ON messages (thread_id, message_type, person_id)
  WHERE message_type = 'dm';

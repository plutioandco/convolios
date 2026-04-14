-- =============================================================================
-- Migration 036: Fix merge_persons — restore full logic with trigger bypass
--
-- The 034 rewrite of merge_persons dropped critical logic from 025:
--   - merged_person_name (NOT NULL in merge_log) → INSERT fails
--   - merged_identities snapshot → undo_merge can't reverse
--   - circle_members transfer
--   - status promotion
--   - auth.uid() check
-- This migration restores the complete logic and adds trigger bypass.
-- =============================================================================

DROP FUNCTION IF EXISTS public.merge_persons(text, uuid, uuid);

CREATE FUNCTION public.merge_persons(
  p_user_id text,
  p_keep_id uuid,
  p_merge_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log_id uuid;
  v_name text;
  v_identities jsonb;
  v_msg_count integer;
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT display_name INTO v_name FROM persons WHERE id = p_merge_id AND user_id = p_user_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Person not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = p_keep_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Keep person not found';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'channel', channel, 'handle', handle)), '[]'::jsonb)
  INTO v_identities
  FROM identities WHERE person_id = p_merge_id;

  SELECT COUNT(*) INTO v_msg_count FROM messages WHERE person_id = p_merge_id;

  INSERT INTO merge_log (user_id, keep_person_id, merged_person_id, merged_person_name, merged_identities, merged_message_count)
  VALUES (p_user_id, p_keep_id, p_merge_id, v_name, v_identities, v_msg_count)
  RETURNING id INTO v_log_id;

  ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

  UPDATE identities SET person_id = p_keep_id WHERE person_id = p_merge_id;
  UPDATE messages SET person_id = p_keep_id WHERE person_id = p_merge_id;
  UPDATE circle_members SET person_id = p_keep_id WHERE person_id = p_merge_id
    AND NOT EXISTS (SELECT 1 FROM circle_members cm2 WHERE cm2.circle_id = circle_members.circle_id AND cm2.person_id = p_keep_id);
  DELETE FROM circle_members WHERE person_id = p_merge_id;

  IF (SELECT status FROM persons WHERE id = p_merge_id) = 'approved' THEN
    UPDATE persons SET status = 'approved' WHERE id = p_keep_id;
  END IF;

  DELETE FROM persons WHERE id = p_merge_id;

  ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;

  RETURN v_log_id;
END;
$$;

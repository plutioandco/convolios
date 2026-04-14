-- =============================================================================
-- Migration 034: Message routing safeguards
-- Prevents messages from being routed to wrong persons/threads at the DB level.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Trigger 1: Enforce DM thread_id → person_id consistency
-- A DM thread can only belong to ONE person. If a message tries to insert
-- with a thread_id that already has DM messages from a DIFFERENT person_id,
-- the insert is REJECTED. This prevents any code path from cross-contaminating
-- conversations — even if resolve_chat or backfill has a bug.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_dm_thread_ownership()
RETURNS TRIGGER AS $$
DECLARE
  existing_person_id uuid;
BEGIN
  IF NEW.message_type <> 'dm' THEN
    RETURN NEW;
  END IF;

  SELECT DISTINCT m.person_id INTO existing_person_id
  FROM messages m
  WHERE m.thread_id = NEW.thread_id
    AND m.message_type = 'dm'
    AND m.person_id <> NEW.person_id
  LIMIT 1;

  IF existing_person_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DM thread % already belongs to person %, cannot assign to person %',
      NEW.thread_id, existing_person_id, NEW.person_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_dm_thread_ownership ON messages;
CREATE TRIGGER trg_check_dm_thread_ownership
  BEFORE INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION check_dm_thread_ownership();

-- ---------------------------------------------------------------------------
-- Trigger 2: Prevent thread_id changes on existing messages
-- Once a message is inserted, its thread_id is IMMUTABLE. No code path
-- should ever bulk-update thread_ids — the destructive patch_stale_thread_ids
-- pattern must never be possible again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_thread_id_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.thread_id IS NOT NULL AND NEW.thread_id <> OLD.thread_id THEN
    RAISE EXCEPTION
      'Cannot change thread_id from % to % on message %',
      OLD.thread_id, NEW.thread_id, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_thread_id_change ON messages;
CREATE TRIGGER trg_prevent_thread_id_change
  BEFORE UPDATE ON messages
  FOR EACH ROW
  WHEN (OLD.thread_id IS DISTINCT FROM NEW.thread_id)
  EXECUTE FUNCTION prevent_thread_id_change();

-- ---------------------------------------------------------------------------
-- Trigger 3: Prevent person_id changes on existing messages
-- Same principle — once assigned, a message's person_id is immutable.
-- Merge operations should use dedicated RPCs that handle this correctly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_person_id_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.person_id IS NOT NULL AND NEW.person_id <> OLD.person_id THEN
    RAISE EXCEPTION
      'Cannot change person_id from % to % on message %',
      OLD.person_id, NEW.person_id, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_person_id_change ON messages;
CREATE TRIGGER trg_prevent_person_id_change
  BEFORE UPDATE ON messages
  FOR EACH ROW
  WHEN (OLD.person_id IS DISTINCT FROM NEW.person_id)
  EXECUTE FUNCTION prevent_person_id_change();

-- ---------------------------------------------------------------------------
-- The merge_persons RPC needs to bypass the person_id immutability trigger
-- when legitimately merging persons. We grant this by having the merge RPC
-- temporarily disable the trigger within its transaction.
-- Update merge_persons to handle the trigger:
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.merge_persons(text, uuid, uuid);
CREATE FUNCTION public.merge_persons(
  p_user_id text,
  p_keep_id uuid,
  p_merge_id uuid
) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = p_keep_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'keep_id not found or not owned by user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = p_merge_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'merge_id not found or not owned by user';
  END IF;

  ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

  UPDATE messages SET person_id = p_keep_id WHERE person_id = p_merge_id;
  UPDATE identities SET person_id = p_keep_id WHERE person_id = p_merge_id;
  DELETE FROM persons WHERE id = p_merge_id;

  INSERT INTO merge_log (user_id, keep_person_id, merged_person_id)
  VALUES (p_user_id, p_keep_id, p_merge_id);

  ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Send audit log: records every send attempt for forensic debugging.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS send_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_id     text NOT NULL,
  person_id   uuid NOT NULL,
  channel     text NOT NULL,
  frontend_chat_id   text,
  resolved_chat_id   text,
  resolved_account_id text,
  outcome     text NOT NULL, -- 'sent', 'blocked', 'error'
  detail      text
);

ALTER TABLE send_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY send_audit_log_owner ON send_audit_log
  FOR ALL USING (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- ---------------------------------------------------------------------------
-- Fix undo_merge to bypass safeguard triggers during legitimate undo ops.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Indexes for performance
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_send_audit_log_user_created
  ON send_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread_type_person
  ON messages (thread_id, message_type, person_id)
  WHERE message_type = 'dm';

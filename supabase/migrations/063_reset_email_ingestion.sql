-- =============================================================================
-- Migration 063: reset_email_ingestion RPC (one-shot data repair)
--
-- Fix for the bug addressed in migration 062 + the Rust backfill refactor.
-- Existing email messages were assigned to a single person per Gmail thread,
-- so multiple distinct senders (e.g. Emirates Airlines + Emirates NBD) got
-- collapsed onto one contact. The trg_prevent_person_id_change trigger makes
-- it impossible to correct the person_id on existing rows.
--
-- This RPC clears email ingestion state for the calling user so that a
-- fresh backfill (with the fixed per-sender resolution) produces the
-- correct persons. It only touches the caller's own data.
--
-- After calling this, the client must trigger backfill_messages again.
--
-- Usage (from the app):
--   await supabase.rpc('reset_email_ingestion', { p_user_id: user.id })
--   await invoke('backfill_messages', { userId: user.id })
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reset_email_ingestion(p_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_messages_deleted  integer;
  v_identities_deleted integer;
  v_persons_deleted   integer;
BEGIN
  IF p_user_id IS NULL OR p_user_id <> (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Triggers must be bypassed because we're intentionally wiping state.
  -- The DELETE on messages cascades to triage_events, commitments, questions.
  ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

  DELETE FROM messages
  WHERE user_id = p_user_id
    AND channel = 'email';
  GET DIAGNOSTICS v_messages_deleted = ROW_COUNT;

  DELETE FROM identities
  WHERE user_id = p_user_id
    AND channel = 'email';
  GET DIAGNOSTICS v_identities_deleted = ROW_COUNT;

  -- Remove persons that have no remaining identities and no remaining
  -- messages. These are the previously-merged email-only ghosts.
  WITH deleted AS (
    DELETE FROM persons p
    WHERE p.user_id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.person_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.person_id = p.id)
    RETURNING 1
  )
  SELECT count(*) INTO v_persons_deleted FROM deleted;

  ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;

  RETURN jsonb_build_object(
    'messages_deleted',  v_messages_deleted,
    'identities_deleted', v_identities_deleted,
    'persons_deleted',   v_persons_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_email_ingestion(text) FROM public;
GRANT EXECUTE ON FUNCTION public.reset_email_ingestion(text) TO authenticated;

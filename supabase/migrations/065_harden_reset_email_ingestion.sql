-- =============================================================================
-- Migration 065: Harden reset_email_ingestion (auth + safe trigger re-enable)
--
-- Fixes NULL auth.uid() bypass: `p_user_id <> (auth.uid())::text` is not true
-- when auth.uid() is NULL, so a SECURITY DEFINER call without a valid JWT
-- could delete another user's data by passing p_user_id.
-- Wraps the destructive section so triggers are re-enabled if DELETE fails.
-- Replaces 063's function body; safe to run if 063 is already applied.
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
  IF p_user_id IS NULL OR auth.uid() IS NULL
     OR p_user_id IS DISTINCT FROM (auth.uid())::text
  THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_messages_deleted := 0;
  v_identities_deleted := 0;
  v_persons_deleted := 0;

  BEGIN
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

    WITH deleted AS (
      DELETE FROM persons p
      WHERE p.user_id = p_user_id
        AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.person_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.person_id = p.id)
      RETURNING 1
    )
    SELECT count(*)::integer INTO v_persons_deleted FROM deleted;

    ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
    ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;
  EXCEPTION
    WHEN OTHERS THEN
      BEGIN
        ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
        ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
      RAISE;
  END;

  RETURN jsonb_build_object(
    'messages_deleted',  v_messages_deleted,
    'identities_deleted', v_identities_deleted,
    'persons_deleted',   v_persons_deleted
  );
END;
$$;

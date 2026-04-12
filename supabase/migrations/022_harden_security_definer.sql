-- 022: Harden SECURITY DEFINER RPCs.
--
-- backfill_find_or_create_person: Only called from the Rust backend with
-- the service role key. Revoke EXECUTE from frontend roles so an
-- authenticated user cannot call it with an arbitrary p_user_id.
--
-- mark_conversation_read: Called from the frontend. Add auth.uid() guard
-- so the caller can only mark their own conversations as read.

REVOKE EXECUTE ON FUNCTION public.backfill_find_or_create_person(text, text, text, text, text)
  FROM authenticated, anon, public;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_user_id text, p_person_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;

  UPDATE messages
  SET read_at = now()
  WHERE user_id = p_user_id
    AND person_id = p_person_id
    AND direction = 'inbound'
    AND read_at IS NULL;
END;
$$;

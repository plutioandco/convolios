-- 049: Auto-promote pending persons who have outbound messages.
-- If the user has sent a message to someone, that person should not
-- be stuck in the screener.  Called at the end of startup_sync.

CREATE OR REPLACE FUNCTION public.promote_engaged_persons(p_user_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE persons p
  SET    status     = 'approved',
         updated_at = now()
  WHERE  p.user_id = p_user_id
    AND  p.status  = 'pending'
    AND  EXISTS (
      SELECT 1 FROM messages m
      WHERE m.person_id = p.id
        AND m.direction  = 'outbound'
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_engaged_persons(text)
  FROM authenticated, anon, public;

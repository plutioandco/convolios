-- 051: Scheduled cleanup for expired x_oauth_state rows.
-- OAuth state rows are single-use but not always consumed (user cancels flow).
-- This function purges rows older than 1 hour.

CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_state()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM x_oauth_state WHERE created_at < now() - interval '1 hour';
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_oauth_state()
  FROM authenticated, anon, public;

-- Run initial cleanup
SELECT public.cleanup_expired_oauth_state();

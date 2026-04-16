-- 052: Schedule the x_oauth_state cleanup function so stale rows don't accumulate.
-- Requires pg_cron, which ships with Supabase Postgres.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup_expired_oauth_state') THEN
    PERFORM cron.unschedule('cleanup_expired_oauth_state');
  END IF;

  PERFORM cron.schedule(
    'cleanup_expired_oauth_state',
    '*/15 * * * *',
    $job$ SELECT public.cleanup_expired_oauth_state(); $job$
  );
END$$;

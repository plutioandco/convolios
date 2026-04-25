-- =============================================================================
-- 064: Per-thread Unipile history backfill state
-- =============================================================================
-- Decouples "full message history has been pulled at least once" from
-- "any row exists in messages" so a webhook-first thread still gets older
-- messages on the next startup_sync / sync_chat tick.
-- Tauri uses the service role for reads/writes; RLS protects direct client use.

CREATE TABLE IF NOT EXISTS public.chat_sync_state (
  user_id text NOT NULL,
  thread_id text NOT NULL,
  channel text NOT NULL DEFAULT '',
  unipile_account_id text,
  backfilled_at timestamptz,
  oldest_sent_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_sync_state_needs_backfill
  ON public.chat_sync_state (user_id)
  WHERE backfilled_at IS NULL;

ALTER TABLE public.chat_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_sync_state_select ON public.chat_sync_state
  FOR SELECT USING (user_id = (current_setting('request.jwt.claims', true)::json->>'sub'));

CREATE POLICY chat_sync_state_insert ON public.chat_sync_state
  FOR INSERT WITH CHECK (user_id = (current_setting('request.jwt.claims', true)::json->>'sub'));

CREATE POLICY chat_sync_state_update ON public.chat_sync_state
  FOR UPDATE USING (user_id = (current_setting('request.jwt.claims', true)::json->>'sub'));

COMMENT ON TABLE public.chat_sync_state IS
  'Unipile chat (thread_id) history: backfilled_at set once a full cursor walk has completed.';

-- 060: Make messages (user_id, external_id) unique index full (non-partial).
--
-- Migration 050 created a PARTIAL unique index with `WHERE external_id IS NOT
-- NULL`. PostgREST's `?on_conflict=user_id,external_id` header cannot express
-- the partial predicate, so Postgres rejects every upsert with:
--   42P10: "there is no unique or exclusion constraint matching the
--           ON CONFLICT specification"
--
-- Every Rust upsert path (startup_sync, sync_chat, backfill_imessage,
-- backfill_x_dms, reconcile_unipile) has been silently failing since 050
-- shipped — the error only surfaced once Phase 0 added err_log!.
--
-- Fix: drop the partial predicate. NULLs are allowed multiple times in a
-- full unique index (NULL ≠ NULL in UNIQUE semantics), so rows without an
-- external_id still coexist without being treated as duplicates. PostgREST
-- can then infer the full index from `on_conflict=user_id,external_id`.

DROP INDEX IF EXISTS messages_external_id_user_idx;

CREATE UNIQUE INDEX messages_external_id_user_idx
  ON messages(user_id, external_id);

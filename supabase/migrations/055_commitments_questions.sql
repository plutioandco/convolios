-- 055: Commitments + Unanswered Questions.
--
-- AI-extracted structured data off every inbound message (and outbound, for
-- "my commitments"). Powers the thread banner ("3 open questions") and the
-- Library → Commitments sub-view.
--
-- Design choices:
-- - Separate tables per concept: questions and commitments have different
--   lifecycles and different UX. Joining them via `kind` would complicate
--   both queries.
-- - Commitments have a `direction` (mine | theirs) because UX for each is
--   distinct — "I owe them a deliverable" vs "they owe me one".
-- - `resolved_at` + `resolved_by_message_id` captures who/how it was closed.
-- - Trigger auto-resolves open questions when an outbound message arrives:
--   most of the time the reply answers the question. The user can unresolve
--   via RPC if the model hallucinated or the reply sidestepped the question.

-- ─── 1. unanswered_questions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unanswered_questions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 TEXT NOT NULL,
  person_id               UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  question_text           TEXT NOT NULL,
  asked_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  resolved_by_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uq_person_open
  ON unanswered_questions(user_id, person_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_uq_message
  ON unanswered_questions(message_id);

-- ─── 2. commitments ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commitments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 TEXT NOT NULL,
  person_id               UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  direction               TEXT NOT NULL CHECK (direction IN ('mine', 'theirs')),
  commitment_text         TEXT NOT NULL,
  due_hint                TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  resolved_by_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_commitments_person_open
  ON commitments(user_id, person_id, direction)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_commitments_message
  ON commitments(message_id);

-- ─── 3. Auto-resolve questions when outbound message arrives ─────────────────
-- Heuristic: a reply from the user to a person answers any open questions.
-- False positives (user sidesteps the question) are recoverable via RPC.

CREATE OR REPLACE FUNCTION public.resolve_open_questions_on_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.person_id IS NOT NULL THEN
    UPDATE unanswered_questions
       SET resolved_at = NEW.sent_at,
           resolved_by_message_id = NEW.id
     WHERE person_id = NEW.person_id
       AND resolved_at IS NULL
       AND asked_at <= NEW.sent_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_resolve_questions_on_reply ON messages;
CREATE TRIGGER trg_resolve_questions_on_reply
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION public.resolve_open_questions_on_reply();

-- ─── 4. RPCs for UI actions ──────────────────────────────────────────────────

-- Mark a single question resolved (user dismisses via UI).
CREATE OR REPLACE FUNCTION public.resolve_question(p_question_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id TEXT;
BEGIN
  SELECT user_id INTO v_user_id FROM unanswered_questions WHERE id = p_question_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Question not found'; END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  UPDATE unanswered_questions
     SET resolved_at = now()
   WHERE id = p_question_id AND resolved_at IS NULL;
END;
$$;

-- Undo: user re-opens a question.
CREATE OR REPLACE FUNCTION public.unresolve_question(p_question_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id TEXT;
BEGIN
  SELECT user_id INTO v_user_id FROM unanswered_questions WHERE id = p_question_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Question not found'; END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  UPDATE unanswered_questions
     SET resolved_at = NULL, resolved_by_message_id = NULL
   WHERE id = p_question_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_commitment(p_commitment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id TEXT;
BEGIN
  SELECT user_id INTO v_user_id FROM commitments WHERE id = p_commitment_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Commitment not found'; END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  UPDATE commitments
     SET resolved_at = now()
   WHERE id = p_commitment_id AND resolved_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.unresolve_commitment(p_commitment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user_id TEXT;
BEGIN
  SELECT user_id INTO v_user_id FROM commitments WHERE id = p_commitment_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Commitment not found'; END IF;
  IF v_user_id <> coalesce(auth.uid()::text, '') THEN
    RAISE EXCEPTION 'Forbidden: user_id mismatch';
  END IF;
  UPDATE commitments
     SET resolved_at = NULL, resolved_by_message_id = NULL
   WHERE id = p_commitment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_question(uuid)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.unresolve_question(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_commitment(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.unresolve_commitment(uuid) TO authenticated;

-- ─── 5. RLS (row-level security) ─────────────────────────────────────────────
ALTER TABLE unanswered_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitments          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uq_own ON unanswered_questions;
CREATE POLICY uq_own ON unanswered_questions
  FOR ALL
  USING (user_id = coalesce(auth.uid()::text, ''))
  WITH CHECK (user_id = coalesce(auth.uid()::text, ''));

DROP POLICY IF EXISTS commitments_own ON commitments;
CREATE POLICY commitments_own ON commitments
  FOR ALL
  USING (user_id = coalesce(auth.uid()::text, ''))
  WITH CHECK (user_id = coalesce(auth.uid()::text, ''));

-- ─── 6. Thread context RPC ──────────────────────────────────────────────────
-- Single round-trip for the thread banner: open questions + pending
-- commitments (both directions) for a person.

CREATE OR REPLACE FUNCTION public.get_thread_context(p_person_id UUID)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'questions', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', id,
          'question_text', question_text,
          'asked_at', asked_at,
          'message_id', message_id
        ) ORDER BY asked_at DESC
      )
      FROM unanswered_questions
      WHERE person_id = p_person_id
        AND user_id = coalesce(auth.uid()::text, '')
        AND resolved_at IS NULL
    ), '[]'::jsonb),
    'commitments', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', id,
          'commitment_text', commitment_text,
          'direction', direction,
          'due_hint', due_hint,
          'created_at', created_at,
          'message_id', message_id
        ) ORDER BY created_at DESC
      )
      FROM commitments
      WHERE person_id = p_person_id
        AND user_id = coalesce(auth.uid()::text, '')
        AND resolved_at IS NULL
    ), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_thread_context(uuid) TO authenticated;

-- ─── 7. Sidebar count: my open commitments across all persons ───────────────
CREATE OR REPLACE FUNCTION public.get_open_commitments_count(p_user_id TEXT)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'mine',   COUNT(*) FILTER (WHERE direction = 'mine'   AND resolved_at IS NULL),
    'theirs', COUNT(*) FILTER (WHERE direction = 'theirs' AND resolved_at IS NULL),
    'questions', (
      SELECT COUNT(*) FROM unanswered_questions
      WHERE user_id = p_user_id AND resolved_at IS NULL
    )
  )
  FROM commitments
  WHERE user_id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_open_commitments_count(text) TO authenticated;

-- 058: Idempotent context extraction.
--
-- The Unipile webhook re-runs AI extraction whenever a message is upserted.
-- Upserts happen on retries, edits, and reconnects — without uniqueness, every
-- retry inserts duplicate questions/commitments and the thread banner starts
-- showing the same question three times. Uniqueness is enforced here so the
-- edge function can just INSERT ... ON CONFLICT DO NOTHING and stay simple.

-- Clean up any duplicates created before this migration.
DELETE FROM unanswered_questions a
USING unanswered_questions b
WHERE a.message_id = b.message_id
  AND a.question_text = b.question_text
  AND a.id > b.id;

DELETE FROM commitments a
USING commitments b
WHERE a.message_id     = b.message_id
  AND a.direction      = b.direction
  AND a.commitment_text = b.commitment_text
  AND a.id > b.id;

-- Add the uniqueness the extraction pipeline relies on.
ALTER TABLE unanswered_questions
  DROP CONSTRAINT IF EXISTS unanswered_questions_uniq;
ALTER TABLE unanswered_questions
  ADD CONSTRAINT unanswered_questions_uniq
  UNIQUE (message_id, question_text);

ALTER TABLE commitments
  DROP CONSTRAINT IF EXISTS commitments_uniq;
ALTER TABLE commitments
  ADD CONSTRAINT commitments_uniq
  UNIQUE (message_id, direction, commitment_text);

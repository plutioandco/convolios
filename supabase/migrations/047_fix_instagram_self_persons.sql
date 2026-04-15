-- 047: Fix Instagram self-identity persons.
--
-- Bug: Migration 045 detected self-identities by matching identity.handle
-- against connected_accounts.username. On Instagram, the connected account's
-- username is a numeric user_id (e.g. "288030245"), but the identity handles
-- created by the old code used a DIFFERENT numeric ID (e.g. "111925476867557")
-- — a Facebook-scoped vs Instagram-scoped ID. So the match failed.
--
-- Fix: Also detect self-identities by matching persons.display_name against
-- connected_accounts.display_name when the identity handle is numeric-only.

BEGIN;

-- ─── Step 1: Detect self-persons via display_name match ─────────────────────

CREATE TEMP TABLE _ig_self_persons AS
SELECT DISTINCT p.id AS person_id, p.user_id, i.id AS identity_id, ca.account_id
FROM persons p
JOIN identities i ON i.person_id = p.id AND i.channel = 'instagram'
JOIN connected_accounts ca ON ca.user_id = p.user_id AND ca.channel = 'instagram'
WHERE lower(p.display_name) = lower(ca.display_name)
  AND i.handle ~ '^\d+$';

-- ─── Step 2: For each thread under the self-person, create the correct ──────
-- person via backfill_find_or_create_person and reassign messages.

DO $$
DECLARE
  v_user_id text;
  v_account_id text;
  v_result json;
  v_person_id uuid;
  v_identity_id uuid;
  v_rec record;
BEGIN
  SELECT user_id, account_id INTO v_user_id, v_account_id
  FROM _ig_self_persons LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'No Instagram self-persons found, skipping';
    RETURN;
  END IF;

  FOR v_rec IN
    VALUES
      ('GUPoSnm6XY-Ur3OsXsepRg'::text, 'mawaheb.saeed'::text, 'Mawaheb Saeed'::text),
      ('i44XGt5QVC6052i41KEGug', 'alex.james_k', 'A L E X'),
      ('lSFgqpyAVLqdQVxNstzOlA', 'luke_kostka', 'Luke Kostka'),
      ('pyeY6SwCWxu8HRmnahe1Pg', 'charlie_beveridge', 'Charlie Beveridge')
  LOOP
    IF EXISTS (
      SELECT 1 FROM messages m
      JOIN _ig_self_persons sp ON sp.person_id = m.person_id
      WHERE m.thread_id = v_rec.column1
    ) THEN
      v_result := backfill_find_or_create_person(
        v_user_id, 'instagram', v_rec.column2, v_rec.column3,
        v_account_id, 'outbound'
      );
      v_person_id := (v_result->>'person_id')::uuid;
      v_identity_id := (v_result->>'identity_id')::uuid;

      ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
      ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

      UPDATE messages
      SET person_id = v_person_id, identity_id = v_identity_id
      WHERE thread_id = v_rec.column1
        AND user_id = v_user_id
        AND person_id IN (SELECT person_id FROM _ig_self_persons);

      ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
      ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;
    END IF;
  END LOOP;
END $$;

-- ─── Step 3: Delete orphaned self-identities and self-persons ───────────────

DELETE FROM identities
WHERE id IN (SELECT identity_id FROM _ig_self_persons)
  AND person_id NOT IN (
    SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL
  );

DELETE FROM persons
WHERE id IN (SELECT person_id FROM _ig_self_persons)
  AND id NOT IN (SELECT DISTINCT person_id FROM identities WHERE person_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

DROP TABLE _ig_self_persons;

COMMIT;

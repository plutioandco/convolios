-- 043: Fix WhatsApp LID handles and merge duplicate persons.
--
-- normalize_handle incorrectly prefixed WhatsApp LID handles with '+'.
-- LIDs are internal WhatsApp IDs (from @lid suffix), NOT phone numbers.
-- This created duplicate persons: one with the real phone (+971506349604)
-- and one with the LID (+244705895923905) for the same contact.
--
-- Strategy: strip bogus '+' from LID handles, then merge persons that
-- share the same thread_id (the reliable signal for same-chat duplicates).

BEGIN;

-- Step 1: Strip '+' from WhatsApp handles that are clearly LIDs (>13 digits).
UPDATE identities
SET handle = ltrim(handle, '+')
WHERE channel = 'whatsapp'
  AND handle ~ '^\+\d{14,}$';

-- Step 2: Build a merge plan using thread_id overlap.
CREATE TEMP TABLE _merge_plan AS
WITH thread_persons AS (
  SELECT
    m.thread_id,
    m.person_id,
    count(*) AS msg_count
  FROM messages m
  WHERE m.channel = 'whatsapp'
    AND m.message_type = 'dm'
    AND m.thread_id IS NOT NULL
    AND m.person_id IS NOT NULL
  GROUP BY m.thread_id, m.person_id
),
multi AS (
  SELECT thread_id
  FROM thread_persons
  GROUP BY thread_id
  HAVING count(DISTINCT person_id) > 1
),
ranked AS (
  SELECT
    tp.thread_id,
    tp.person_id,
    tp.msg_count,
    ROW_NUMBER() OVER (
      PARTITION BY tp.thread_id
      ORDER BY tp.msg_count DESC, tp.person_id
    ) AS rn
  FROM thread_persons tp
  WHERE tp.thread_id IN (SELECT thread_id FROM multi)
)
SELECT
  r.person_id AS loser_id,
  w.person_id AS winner_id
FROM ranked r
JOIN ranked w ON w.thread_id = r.thread_id AND w.rn = 1
WHERE r.rn > 1;

-- Step 3: Disable immutability triggers for the merge.
ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

-- Step 4: Move messages from loser to winner.
UPDATE messages m
SET person_id = mp.winner_id
FROM _merge_plan mp
WHERE m.person_id = mp.loser_id;

-- Step 5: Re-enable triggers.
ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;

-- Step 6: Move identities from loser to winner (skip if handle conflict).
UPDATE identities i
SET person_id = mp.winner_id
FROM _merge_plan mp
WHERE i.person_id = mp.loser_id
  AND NOT EXISTS (
    SELECT 1 FROM identities i2
    WHERE i2.channel = i.channel
      AND i2.handle = i.handle
      AND i2.person_id = mp.winner_id
  );

-- Step 7: Delete orphaned identities on loser persons.
DELETE FROM identities
WHERE person_id IN (SELECT loser_id FROM _merge_plan)
  AND person_id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

-- Step 8: Delete orphaned persons.
DELETE FROM persons
WHERE id IN (SELECT loser_id FROM _merge_plan)
  AND id NOT IN (SELECT DISTINCT person_id FROM identities WHERE person_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

DROP TABLE _merge_plan;

-- Step 9: Fix display_names — replace 'Unknown', '.', or phone-only names
-- with the best available identity display_name.
UPDATE persons p
SET display_name = COALESCE(
  (SELECT i.display_name
   FROM identities i
   WHERE i.person_id = p.id
     AND i.display_name IS NOT NULL
     AND i.display_name != ''
     AND i.display_name != 'Unknown'
     AND i.display_name != '.'
     AND i.display_name !~ '^\+?\d[\d\s]*$'
   ORDER BY length(i.display_name) DESC
   LIMIT 1),
  p.display_name
),
updated_at = now()
WHERE p.display_name IN ('.', 'Unknown')
   OR p.display_name ~ '^\+?\d[\d\s]*$';

COMMIT;

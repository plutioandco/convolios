-- Cleanup ghost persons: persons with no identities whose messages should be
-- reassigned to the correct person (identified via shared thread_id).

-- Step 1: Identify ghost persons (have no identities but have messages)
CREATE TEMP TABLE _ghosts AS
SELECT p.id AS ghost_id
FROM persons p
LEFT JOIN identities i ON i.person_id = p.id
WHERE i.id IS NULL
  AND EXISTS (SELECT 1 FROM messages m WHERE m.person_id = p.id);

-- Step 2: For each ghost, find the correct person for each thread_id.
-- The "correct" person is the one with identities who has the most messages
-- in the same thread.
CREATE TEMP TABLE _reassign AS
SELECT DISTINCT ON (gm.id)
  gm.id AS message_id,
  gm.person_id AS ghost_id,
  real_owner.person_id AS correct_person_id
FROM _ghosts g
JOIN messages gm ON gm.person_id = g.ghost_id
JOIN LATERAL (
  SELECT m2.person_id
  FROM messages m2
  JOIN identities i2 ON i2.person_id = m2.person_id
  WHERE m2.thread_id = gm.thread_id
    AND m2.person_id != g.ghost_id
  GROUP BY m2.person_id
  ORDER BY count(*) DESC
  LIMIT 1
) real_owner ON true;

-- Step 3: Disable the person_id change trigger
ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;

-- Step 4: Reassign messages
UPDATE messages m
SET person_id = r.correct_person_id
FROM _reassign r
WHERE m.id = r.message_id;

-- Step 5: Re-enable trigger
ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;

-- Step 6: Delete ghost persons that now have zero messages
-- (ON DELETE CASCADE will clean up any circle_members, merge_dismissed, etc.)
DELETE FROM persons p
USING _ghosts g
WHERE p.id = g.ghost_id
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.person_id = p.id);

DROP TABLE IF EXISTS _ghosts;
DROP TABLE IF EXISTS _reassign;

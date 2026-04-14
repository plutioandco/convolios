-- 029: Fix merge_dismissed primary key to include user_id.
-- The original PK (person_a, person_b) is global across users. If two different
-- users dismiss the same pair of person UUIDs, the second insert gets a PK
-- conflict. user_id must be part of the key.

-- Drop old PK, add new composite PK that includes user_id.
ALTER TABLE merge_dismissed DROP CONSTRAINT IF EXISTS merge_dismissed_pkey;
ALTER TABLE merge_dismissed ADD PRIMARY KEY (user_id, person_a, person_b);

-- 014: One-time data fix — merge duplicate persons
-- Finds persons with the same display_name + user_id and merges them,
-- keeping the oldest (first-created) person and reassigning messages/identities.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT user_id, display_name,
           (SELECT id FROM persons p2
            WHERE p2.user_id = p1.user_id AND p2.display_name = p1.display_name
            ORDER BY p2.created_at ASC LIMIT 1) AS keep_id,
           array_agg(id) AS all_ids
    FROM persons p1
    WHERE display_name IS NOT NULL AND display_name != '' AND display_name != 'Unknown'
    GROUP BY user_id, display_name
    HAVING COUNT(*) > 1
  LOOP
    -- Reassign identities from duplicates to the kept person
    UPDATE identities SET person_id = r.keep_id
    WHERE person_id = ANY(r.all_ids) AND person_id != r.keep_id;

    -- Reassign messages from duplicates to the kept person
    UPDATE messages SET person_id = r.keep_id
    WHERE person_id = ANY(r.all_ids) AND person_id != r.keep_id;

    -- Delete the now-orphaned duplicate person rows
    DELETE FROM persons
    WHERE id = ANY(r.all_ids) AND id != r.keep_id;
  END LOOP;
END;
$$;

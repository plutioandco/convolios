-- 015: Merge fuzzy-duplicate persons
-- Handles cases like "Sandro" vs "Sandro Kratz" where one name is a prefix
-- of the other within the same user_id + channel.
-- Keeps the record with the longer (more complete) display_name.

DO $$
DECLARE
  r RECORD;
  keep_id uuid;
  lose_id uuid;
  keep_exists boolean;
  lose_exists boolean;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (LEAST(a.id, b.id), GREATEST(a.id, b.id))
           a.id AS a_id, a.display_name AS a_name,
           b.id AS b_id, b.display_name AS b_name,
           a.user_id
    FROM persons a
    JOIN persons b ON a.user_id = b.user_id AND a.id < b.id
    WHERE a.display_name IS NOT NULL AND a.display_name != ''
      AND b.display_name IS NOT NULL AND b.display_name != ''
      AND a.display_name != 'Unknown' AND b.display_name != 'Unknown'
      AND (
        lower(b.display_name) LIKE lower(a.display_name) || '%'
        OR lower(a.display_name) LIKE lower(b.display_name) || '%'
      )
    AND EXISTS (
      SELECT 1 FROM identities i1
      JOIN identities i2 ON i1.channel = i2.channel
      WHERE i1.person_id = a.id AND i2.person_id = b.id
    )
  LOOP
    IF length(r.a_name) >= length(r.b_name) THEN
      keep_id := r.a_id;
      lose_id := r.b_id;
    ELSE
      keep_id := r.b_id;
      lose_id := r.a_id;
    END IF;

    SELECT EXISTS(SELECT 1 FROM persons WHERE id = keep_id) INTO keep_exists;
    SELECT EXISTS(SELECT 1 FROM persons WHERE id = lose_id) INTO lose_exists;
    IF NOT keep_exists OR NOT lose_exists THEN
      CONTINUE;
    END IF;

    DELETE FROM messages m_lose
    WHERE m_lose.person_id = lose_id
      AND EXISTS (
        SELECT 1 FROM messages m_keep
        WHERE m_keep.person_id = keep_id
          AND m_keep.direction = m_lose.direction
          AND m_keep.sent_at = m_lose.sent_at
          AND md5(COALESCE(m_keep.body_text, '')) = md5(COALESCE(m_lose.body_text, ''))
      );

    UPDATE identities SET person_id = keep_id WHERE person_id = lose_id;
    UPDATE messages SET person_id = keep_id WHERE person_id = lose_id;
    DELETE FROM persons WHERE id = lose_id;
  END LOOP;
END;
$$;

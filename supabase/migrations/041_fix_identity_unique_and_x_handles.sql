-- 041: Fix identity UNIQUE constraint to be per-user + normalize X handles.
--
-- The original UNIQUE(channel, handle) prevents two users from having the
-- same contact. Replace with UNIQUE(channel, handle, user_id).
-- Also normalize X handles: prefer lowercase username, store numeric ID in metadata.

BEGIN;

-- Step 1: Drop the global unique constraint, add per-user unique constraint.
ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_channel_handle_key;

ALTER TABLE identities ADD CONSTRAINT identities_channel_handle_user_key
  UNIQUE (channel, handle, user_id);

-- Step 2: For X identities that have a numeric-only handle (user ID fallback),
-- check if a username variant exists in metadata and update the handle.
UPDATE identities
SET handle = lower(metadata->>'username')
WHERE channel = 'x'
  AND handle ~ '^\d+$'
  AND metadata->>'username' IS NOT NULL
  AND metadata->>'username' != '';

-- Step 3: Merge duplicate X identities that now share (channel, handle, user_id).
WITH ranked AS (
  SELECT
    i.id AS identity_id,
    i.person_id,
    i.channel,
    i.handle,
    i.user_id,
    COALESCE((SELECT count(*) FROM messages m WHERE m.person_id = i.person_id), 0) AS msg_count,
    ROW_NUMBER() OVER (
      PARTITION BY i.channel, i.handle, i.user_id
      ORDER BY COALESCE((SELECT count(*) FROM messages m WHERE m.person_id = i.person_id), 0) DESC,
               i.created_at ASC
    ) AS rn
  FROM identities i
  WHERE i.channel = 'x'
),
dupes AS (
  SELECT identity_id, person_id
  FROM ranked
  WHERE rn > 1
),
winners AS (
  SELECT d.identity_id AS dupe_identity_id,
         d.person_id   AS dupe_person_id,
         w.person_id   AS winner_person_id
  FROM dupes d
  JOIN ranked w ON w.channel = (SELECT channel FROM identities WHERE id = d.identity_id)
                AND w.handle = (SELECT handle FROM identities WHERE id = d.identity_id)
                AND w.user_id = (SELECT user_id FROM identities WHERE id = d.identity_id)
                AND w.rn = 1
)
UPDATE messages m
SET person_id = w.winner_person_id
FROM winners w
WHERE m.person_id = w.dupe_person_id
  AND w.dupe_person_id != w.winner_person_id;

DELETE FROM identities
WHERE id IN (
  SELECT identity_id FROM (
    SELECT
      i.id AS identity_id,
      ROW_NUMBER() OVER (
        PARTITION BY i.channel, i.handle, i.user_id
        ORDER BY COALESCE((SELECT count(*) FROM messages m WHERE m.person_id = i.person_id), 0) DESC,
                 i.created_at ASC
      ) AS rn
    FROM identities i
    WHERE i.channel = 'x'
  ) sub
  WHERE rn > 1
);

-- Step 4: Delete orphaned persons (no identities, no messages).
DELETE FROM persons
WHERE id NOT IN (SELECT DISTINCT person_id FROM identities)
  AND id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

-- Step 5: Normalize iMessage/SMS handles to E.164 (strip non-digits, add '+').
UPDATE identities
SET handle = '+' || regexp_replace(handle, '[^0-9]', '', 'g')
WHERE channel IN ('imessage', 'sms')
  AND handle !~ '^\+'
  AND length(regexp_replace(handle, '[^0-9]', '', 'g')) BETWEEN 7 AND 15;

-- Step 6: Merge duplicate iMessage/SMS identities after normalization.
WITH ranked AS (
  SELECT
    i.id AS identity_id,
    i.person_id,
    i.channel,
    i.handle,
    i.user_id,
    COALESCE((SELECT count(*) FROM messages m WHERE m.person_id = i.person_id), 0) AS msg_count,
    ROW_NUMBER() OVER (
      PARTITION BY i.channel, i.handle, i.user_id
      ORDER BY COALESCE((SELECT count(*) FROM messages m WHERE m.person_id = i.person_id), 0) DESC,
               i.created_at ASC
    ) AS rn
  FROM identities i
  WHERE i.channel IN ('imessage', 'sms')
),
dupes AS (
  SELECT identity_id, person_id
  FROM ranked
  WHERE rn > 1
),
winners AS (
  SELECT d.identity_id AS dupe_identity_id,
         d.person_id   AS dupe_person_id,
         w.person_id   AS winner_person_id
  FROM dupes d
  JOIN ranked w ON w.channel = (SELECT channel FROM identities WHERE id = d.identity_id)
                AND w.handle = (SELECT handle FROM identities WHERE id = d.identity_id)
                AND w.user_id = (SELECT user_id FROM identities WHERE id = d.identity_id)
                AND w.rn = 1
)
UPDATE messages m
SET person_id = w.winner_person_id
FROM winners w
WHERE m.person_id = w.dupe_person_id
  AND w.dupe_person_id != w.winner_person_id;

DELETE FROM identities
WHERE id IN (
  SELECT identity_id FROM (
    SELECT
      i.id AS identity_id,
      ROW_NUMBER() OVER (
        PARTITION BY i.channel, i.handle, i.user_id
        ORDER BY COALESCE((SELECT count(*) FROM messages m WHERE m.person_id = i.person_id), 0) DESC,
                 i.created_at ASC
      ) AS rn
    FROM identities i
    WHERE i.channel IN ('imessage', 'sms')
  ) sub
  WHERE rn > 1
);

DELETE FROM persons
WHERE id NOT IN (SELECT DISTINCT person_id FROM identities)
  AND id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

-- Step 7: Update backfill_find_or_create_person with X variant matching.
CREATE OR REPLACE FUNCTION public.backfill_find_or_create_person(
  p_user_id text,
  p_channel text,
  p_handle text,
  p_display_name text,
  p_unipile_account_id text,
  p_direction text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person_id uuid;
  v_identity_id uuid;
  v_orphan_id uuid;
  v_status text;
  v_stripped text;
BEGIN
  -- Exact match first
  SELECT i.id, i.person_id INTO v_identity_id, v_person_id
  FROM identities i
  JOIN persons p ON p.id = i.person_id
  WHERE i.channel = p_channel
    AND i.handle = p_handle
    AND p.user_id = p_user_id
  LIMIT 1;

  -- Fallback: variant matches for WhatsApp handles (with/without '+' prefix)
  IF v_person_id IS NULL AND p_channel = 'whatsapp' THEN
    v_stripped := regexp_replace(p_handle, '^\+', '');
    SELECT i.id, i.person_id INTO v_identity_id, v_person_id
    FROM identities i
    JOIN persons p ON p.id = i.person_id
    WHERE i.channel = p_channel
      AND i.handle IN (p_handle, v_stripped, '+' || v_stripped)
      AND p.user_id = p_user_id
    LIMIT 1;

    IF v_identity_id IS NOT NULL AND v_stripped ~ '^\d+$' THEN
      UPDATE identities SET handle = '+' || v_stripped WHERE id = v_identity_id AND handle != '+' || v_stripped;
    END IF;
  END IF;

  -- Fallback: X variant matching — check metadata x_user_id for numeric ID → username migration
  IF v_person_id IS NULL AND p_channel = 'x' AND p_metadata IS NOT NULL THEN
    IF p_metadata->>'x_user_id' IS NOT NULL THEN
      SELECT i.id, i.person_id INTO v_identity_id, v_person_id
      FROM identities i
      JOIN persons p ON p.id = i.person_id
      WHERE i.channel = 'x'
        AND (i.handle = p_metadata->>'x_user_id' OR i.metadata->>'x_user_id' = p_metadata->>'x_user_id')
        AND p.user_id = p_user_id
      LIMIT 1;

      IF v_identity_id IS NOT NULL AND p_handle != (SELECT handle FROM identities WHERE id = v_identity_id) THEN
        UPDATE identities SET handle = p_handle, metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb)
        WHERE id = v_identity_id;
      END IF;
    END IF;
  END IF;

  -- Fallback: iMessage/SMS variant matching (E.164 with/without '+')
  IF v_person_id IS NULL AND p_channel IN ('imessage', 'sms') THEN
    v_stripped := regexp_replace(p_handle, '[^0-9]', '', 'g');
    IF length(v_stripped) BETWEEN 7 AND 15 THEN
      SELECT i.id, i.person_id INTO v_identity_id, v_person_id
      FROM identities i
      JOIN persons p ON p.id = i.person_id
      WHERE i.channel = p_channel
        AND regexp_replace(i.handle, '[^0-9]', '', 'g') = v_stripped
        AND p.user_id = p_user_id
      LIMIT 1;

      IF v_identity_id IS NOT NULL THEN
        UPDATE identities SET handle = '+' || v_stripped WHERE id = v_identity_id AND handle != '+' || v_stripped;
      END IF;
    END IF;
  END IF;

  IF v_person_id IS NOT NULL THEN
    IF p_display_name IS NOT NULL AND p_display_name != 'Unknown' THEN
      UPDATE persons SET display_name = p_display_name, updated_at = now()
      WHERE id = v_person_id AND display_name = 'Unknown';
    END IF;
    IF p_metadata IS NOT NULL AND p_metadata != '{}'::jsonb THEN
      UPDATE identities
      SET metadata = COALESCE(metadata, '{}'::jsonb) || p_metadata
      WHERE id = v_identity_id;
    END IF;
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  v_status := CASE WHEN p_direction = 'outbound' THEN 'approved' ELSE 'pending' END;

  INSERT INTO persons (user_id, display_name, status)
  VALUES (p_user_id, p_display_name, v_status)
  RETURNING id INTO v_person_id;

  v_orphan_id := v_person_id;

  BEGIN
    INSERT INTO identities (person_id, channel, handle, display_name, unipile_account_id, user_id, metadata)
    VALUES (v_person_id, p_channel, p_handle, p_display_name, p_unipile_account_id, p_user_id, COALESCE(p_metadata, '{}'::jsonb))
    RETURNING id INTO v_identity_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT i.id, i.person_id INTO v_identity_id, v_person_id
    FROM identities i WHERE i.channel = p_channel AND i.handle = p_handle AND i.user_id = p_user_id
    LIMIT 1;
    IF v_orphan_id != v_person_id THEN
      DELETE FROM persons WHERE id = v_orphan_id;
    END IF;
  END;

  RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
END;
$$
;

REVOKE EXECUTE ON FUNCTION public.backfill_find_or_create_person(text, text, text, text, text, text, jsonb)
  FROM authenticated, anon, public;

COMMIT;

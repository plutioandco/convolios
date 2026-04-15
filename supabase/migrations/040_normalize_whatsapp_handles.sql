-- 040: Normalize WhatsApp identity handles and merge resulting duplicates.
-- The Rust normalize_handle had an `is_lid` guard that skipped adding the '+'
-- prefix for LID-format handles (e.g. "17053026490@lid" → "17053026490"),
-- while the webhook correctly produced "+17053026490". This created duplicate
-- person records for the same WhatsApp contact.

BEGIN;

-- Step 1: Add '+' prefix to WhatsApp handles that are pure digits (missing the prefix).
UPDATE identities
SET handle = '+' || handle
WHERE channel = 'whatsapp'
  AND handle ~ '^\d+$'
  AND length(handle) <= 15;

-- Step 2: Merge duplicate identities that now share the same (channel, handle, user_id).
-- Keep the identity linked to the person with the most messages.
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
  WHERE i.channel = 'whatsapp'
),
dupes AS (
  SELECT identity_id, person_id
  FROM ranked
  WHERE rn > 1
),
-- For each duplicate identity, find the "winner" person (rn=1 in the same group)
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
-- Step 3: Re-point messages from duplicate person to winner person
UPDATE messages m
SET person_id = w.winner_person_id
FROM winners w
WHERE m.person_id = w.dupe_person_id
  AND w.dupe_person_id != w.winner_person_id;

-- Step 4: Delete duplicate identities
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
    WHERE i.channel = 'whatsapp'
  ) sub
  WHERE rn > 1
);

-- Step 5: Delete orphaned persons (no identities left)
DELETE FROM persons
WHERE id NOT IN (SELECT DISTINCT person_id FROM identities)
  AND id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

-- Step 6: Harden the backfill_find_or_create_person RPC with variant matching
-- so future lookups also check stripped/prefixed variants.
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

  -- Fallback: try variant matches for WhatsApp handles (with/without '+' prefix)
  IF v_person_id IS NULL AND p_channel = 'whatsapp' THEN
    v_stripped := regexp_replace(p_handle, '^\+', '');
    SELECT i.id, i.person_id INTO v_identity_id, v_person_id
    FROM identities i
    JOIN persons p ON p.id = i.person_id
    WHERE i.channel = p_channel
      AND i.handle IN (p_handle, v_stripped, '+' || v_stripped)
      AND p.user_id = p_user_id
    LIMIT 1;

    -- Normalize the stored handle to the canonical form
    IF v_identity_id IS NOT NULL AND v_stripped ~ '^\d+$' THEN
      UPDATE identities SET handle = '+' || v_stripped WHERE id = v_identity_id AND handle != '+' || v_stripped;
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
    FROM identities i WHERE i.channel = p_channel AND i.handle = p_handle
    LIMIT 1;
    IF v_orphan_id != v_person_id THEN
      DELETE FROM persons WHERE id = v_orphan_id;
    END IF;
  END;

  RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.backfill_find_or_create_person(text, text, text, text, text, text, jsonb)
  FROM authenticated, anon, public;

COMMIT;

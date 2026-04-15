-- 045: Fix persons created from the account owner's own identity.
--
-- Bug: Multiple code paths (webhook, startup_sync) resolved "the other party"
-- using unreliable chat fields instead of the chat_attendees API. On Instagram
-- and other channels, this caused the account owner's ID to be used as a
-- contact handle, creating a "person" for the user themselves.
--
-- Detection: Find identities whose handle matches the connected account's
-- provider-specific user_id/email/phone. These are "self-identities" that
-- should not exist as contacts.
--
-- Strategy: For each self-identity, find the CORRECT person for that thread
-- (using thread_id overlap with other, legitimate persons), merge messages
-- to the correct person, and clean up the self-person.

BEGIN;

-- RPC for the webhook to reassign messages between persons with trigger bypass.
-- This is needed because trg_prevent_person_id_change blocks direct person_id updates.
CREATE OR REPLACE FUNCTION public.reassign_thread_person(
  p_user_id text,
  p_thread_id text,
  p_from_person_id uuid,
  p_to_person_id uuid,
  p_to_identity_id uuid
) RETURNS void AS $$
BEGIN
  ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

  UPDATE messages
  SET person_id = p_to_person_id, identity_id = p_to_identity_id
  WHERE user_id = p_user_id
    AND thread_id = p_thread_id
    AND person_id = p_from_person_id;

  ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
  ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Step 1: Identify "self-identities" — identities whose handle matches the
-- connected account's own identifier.
CREATE TEMP TABLE _self_identities AS
SELECT DISTINCT i.id AS identity_id, i.person_id, i.handle, i.channel, i.user_id,
       ca.account_id
FROM identities i
JOIN connected_accounts ca ON ca.user_id = i.user_id AND ca.provider = 'unipile'
WHERE (
  -- Email: handle matches account email
  (i.channel = 'email' AND lower(i.handle) = lower(ca.email))
  -- Phone-based channels: handle matches account phone
  OR (i.channel IN ('whatsapp', 'sms', 'imessage')
      AND ca.phone IS NOT NULL AND ca.phone != ''
      AND (i.handle = ca.phone
           OR i.handle = '+' || regexp_replace(ca.phone, '\D', '', 'g')
           OR regexp_replace(i.handle, '\D', '', 'g') = regexp_replace(ca.phone, '\D', '', 'g')))
  -- Instagram/LinkedIn: handle matches account username
  OR (i.channel IN ('instagram', 'linkedin')
      AND ca.username IS NOT NULL AND ca.username != ''
      AND lower(i.handle) = lower(ca.username))
)
-- Exclude identities that belong to persons with many messages from others
-- (these are likely legitimate contacts who happen to share a phone/email)
AND NOT EXISTS (
  SELECT 1 FROM messages m
  WHERE m.person_id = i.person_id
    AND m.direction = 'inbound'
  HAVING count(*) > 5
);

-- Step 2: For each self-person, find the correct person via thread overlap.
-- If messages from the self-person share a thread_id with another (correct) person,
-- reassign those messages to the correct person.
CREATE TEMP TABLE _self_merge_plan AS
WITH self_threads AS (
  SELECT DISTINCT m.thread_id, m.person_id AS self_person_id, si.identity_id AS self_identity_id
  FROM messages m
  JOIN _self_identities si ON si.person_id = m.person_id
  WHERE m.thread_id IS NOT NULL
),
correct_persons AS (
  SELECT
    st.thread_id,
    st.self_person_id,
    st.self_identity_id,
    m2.person_id AS correct_person_id,
    m2.identity_id AS correct_identity_id,
    count(*) AS msg_count
  FROM self_threads st
  JOIN messages m2 ON m2.thread_id = st.thread_id
    AND m2.person_id != st.self_person_id
    AND m2.person_id IS NOT NULL
  GROUP BY st.thread_id, st.self_person_id, st.self_identity_id, m2.person_id, m2.identity_id
)
SELECT DISTINCT ON (self_person_id, thread_id)
  thread_id,
  self_person_id,
  self_identity_id,
  correct_person_id,
  correct_identity_id
FROM correct_persons
ORDER BY self_person_id, thread_id, msg_count DESC;

-- Step 3: Disable immutability triggers for the merge.
ALTER TABLE messages DISABLE TRIGGER trg_prevent_person_id_change;
ALTER TABLE messages DISABLE TRIGGER trg_check_dm_thread_ownership;

-- Step 4: Reassign messages from self-person to correct person per thread.
UPDATE messages m
SET
  person_id = smp.correct_person_id,
  identity_id = smp.correct_identity_id
FROM _self_merge_plan smp
WHERE m.person_id = smp.self_person_id
  AND m.thread_id = smp.thread_id;

-- Step 5: Re-enable triggers.
ALTER TABLE messages ENABLE TRIGGER trg_prevent_person_id_change;
ALTER TABLE messages ENABLE TRIGGER trg_check_dm_thread_ownership;

-- Step 6: Delete self-identities that are now orphaned (no messages reference them).
DELETE FROM identities
WHERE id IN (SELECT identity_id FROM _self_identities)
  AND person_id NOT IN (
    SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL
  );

-- Step 7: Delete self-persons that are now orphaned.
DELETE FROM persons
WHERE id IN (SELECT person_id FROM _self_identities)
  AND id NOT IN (SELECT DISTINCT person_id FROM identities WHERE person_id IS NOT NULL)
  AND id NOT IN (SELECT DISTINCT person_id FROM messages WHERE person_id IS NOT NULL);

DROP TABLE _self_merge_plan;
DROP TABLE _self_identities;

COMMIT;

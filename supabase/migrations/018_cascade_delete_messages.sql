-- Fix messages.person_id FK: add ON DELETE CASCADE
-- (constraint name is system-generated, must look it up)
DO $$
DECLARE
  _con text;
BEGIN
  SELECT conname INTO _con
    FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND confrelid = 'public.persons'::regclass
      AND contype = 'f';
  IF _con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', _con);
  END IF;
END $$;

ALTER TABLE messages ADD CONSTRAINT messages_person_id_fkey
  FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE;

-- Fix messages.identity_id FK: add ON DELETE SET NULL
DO $$
DECLARE
  _con text;
BEGIN
  SELECT conname INTO _con
    FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND confrelid = 'public.identities'::regclass
      AND contype = 'f';
  IF _con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', _con);
  END IF;
END $$;

ALTER TABLE messages ADD CONSTRAINT messages_identity_id_fkey
  FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE SET NULL;

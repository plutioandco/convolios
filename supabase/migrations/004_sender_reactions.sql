ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '[]'::jsonb;

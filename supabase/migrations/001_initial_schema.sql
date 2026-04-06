-- Convolios — Initial Schema
-- Run this in Supabase SQL Editor

-- Enable pgvector (should already be enabled, but idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- PERSONS — one row per human relationship
-- ============================================================
CREATE TABLE IF NOT EXISTS persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,              -- Convolios user (Clerk ID)
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  notes TEXT,
  ai_summary TEXT,                    -- cached context brief
  ai_summary_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS persons_user_idx ON persons(user_id);

-- ============================================================
-- IDENTITIES — links a person to their channel handles
-- ============================================================
CREATE TABLE IF NOT EXISTS identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,              -- 'whatsapp', 'linkedin', 'gmail', 'x', 'slack', 'clickup'
  handle TEXT NOT NULL,               -- email, phone, username, account ID
  display_name TEXT,                  -- name as shown on that channel
  unipile_account_id TEXT,            -- for Unipile-managed channels
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(channel, handle)
);

CREATE INDEX IF NOT EXISTS identities_person_idx ON identities(person_id);

-- ============================================================
-- MESSAGES — every message, normalized
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  person_id UUID REFERENCES persons(id),
  identity_id UUID REFERENCES identities(id),
  external_id TEXT UNIQUE,            -- dedup key (unipile_message_id, x_dm_id, etc.)
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,            -- 'inbound' | 'outbound'
  message_type TEXT DEFAULT 'dm',     -- 'dm' | 'group' | 'channel'
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB DEFAULT '[]',
  thread_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now(),
  triage TEXT DEFAULT 'unclassified', -- 'urgent' | 'human' | 'newsletter' | 'notification' | 'noise'
  embedding vector(3072)
);

CREATE INDEX IF NOT EXISTS messages_person_idx ON messages(person_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS messages_user_triage_idx ON messages(user_id, triage, sent_at DESC);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(user_id, channel, sent_at DESC);

-- HNSW index for semantic search (cosine similarity)
CREATE INDEX IF NOT EXISTS messages_embedding_idx ON messages
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ============================================================
-- CONNECTED_ACCOUNTS — user's connected channels
-- ============================================================
CREATE TABLE IF NOT EXISTS connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,             -- 'unipile', 'x', 'slack', 'clickup', 'google_chat'
  channel TEXT NOT NULL,              -- 'whatsapp', 'linkedin', etc.
  account_id TEXT,                    -- provider's account ID
  status TEXT DEFAULT 'active',       -- 'active' | 'disconnected' | 'expired'
  credentials JSONB DEFAULT '{}',     -- encrypted tokens (use Supabase vault in prod)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connected_accounts_user_idx ON connected_accounts(user_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;

-- Policies: users can only access their own data
-- (user_id is the Clerk user ID, passed via Supabase auth or service role)

CREATE POLICY "Users can view own persons"
  ON persons FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own persons"
  ON persons FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can update own persons"
  ON persons FOR UPDATE
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users can view own identities"
  ON identities FOR SELECT
  USING (person_id IN (SELECT id FROM persons WHERE user_id = auth.uid()::text));

CREATE POLICY "Users can view own messages"
  ON messages FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own messages"
  ON messages FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can view own connected_accounts"
  ON connected_accounts FOR SELECT
  USING (auth.uid()::text = user_id);

CREATE POLICY "Users can insert own connected_accounts"
  ON connected_accounts FOR INSERT
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can update own connected_accounts"
  ON connected_accounts FOR UPDATE
  USING (auth.uid()::text = user_id);

-- Service role bypasses RLS, so backend operations (webhook ingest, AI triage) work fine.

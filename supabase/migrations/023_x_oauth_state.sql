CREATE TABLE IF NOT EXISTS x_oauth_state (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE x_oauth_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only" ON x_oauth_state
  USING (auth.role() = 'service_role');

CREATE INDEX idx_x_oauth_state_created ON x_oauth_state (created_at);

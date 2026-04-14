-- 025: Screener (person status), Circles, and Person Merging infrastructure.
-- Adds person approval status, user-created circles, merge audit log,
-- merge dismissed pairs, fuzzy matching extension, and all related RPCs.

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- PERSONS — add status for Screener
-- ============================================================
ALTER TABLE persons ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS persons_status_idx ON persons(user_id, status);

-- ============================================================
-- CIRCLES
-- ============================================================
CREATE TABLE IF NOT EXISTS circles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#5865f2',
  emoji TEXT,
  notify TEXT DEFAULT 'all',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS circles_user_idx ON circles(user_id, sort_order);

CREATE TABLE IF NOT EXISTS circle_members (
  circle_id UUID REFERENCES circles(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (circle_id, person_id)
);

CREATE INDEX IF NOT EXISTS circle_members_person_idx ON circle_members(person_id);

-- ============================================================
-- MERGE INFRASTRUCTURE
-- ============================================================
CREATE TABLE IF NOT EXISTS merge_dismissed (
  person_a UUID NOT NULL,
  person_b UUID NOT NULL,
  user_id TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (person_a, person_b)
);

CREATE TABLE IF NOT EXISTS merge_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  keep_person_id UUID NOT NULL,
  merged_person_id UUID NOT NULL,
  merged_person_name TEXT NOT NULL,
  merged_identities JSONB NOT NULL DEFAULT '[]',
  merged_message_count INTEGER DEFAULT 0,
  merged_at TIMESTAMPTZ DEFAULT now(),
  undone_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS merge_log_user_idx ON merge_log(user_id, merged_at DESC);

-- ============================================================
-- RLS — circles
-- ============================================================
ALTER TABLE circles ENABLE ROW LEVEL SECURITY;
ALTER TABLE circle_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_dismissed ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own circles"
  ON circles FOR SELECT USING (auth.uid()::text = user_id);
CREATE POLICY "Users can insert own circles"
  ON circles FOR INSERT WITH CHECK (auth.uid()::text = user_id);
CREATE POLICY "Users can update own circles"
  ON circles FOR UPDATE USING (auth.uid()::text = user_id);
CREATE POLICY "Users can delete own circles"
  ON circles FOR DELETE USING (auth.uid()::text = user_id);

CREATE POLICY "Users can view own circle_members"
  ON circle_members FOR SELECT
  USING (circle_id IN (SELECT id FROM circles WHERE user_id = auth.uid()::text));
CREATE POLICY "Users can insert own circle_members"
  ON circle_members FOR INSERT
  WITH CHECK (circle_id IN (SELECT id FROM circles WHERE user_id = auth.uid()::text));
CREATE POLICY "Users can delete own circle_members"
  ON circle_members FOR DELETE
  USING (circle_id IN (SELECT id FROM circles WHERE user_id = auth.uid()::text));

CREATE POLICY "Users can view own merge_dismissed"
  ON merge_dismissed FOR SELECT USING (auth.uid()::text = user_id);
CREATE POLICY "Users can insert own merge_dismissed"
  ON merge_dismissed FOR INSERT WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "Users can view own merge_log"
  ON merge_log FOR SELECT USING (auth.uid()::text = user_id);

-- ============================================================
-- UPDATE backfill_find_or_create_person — add p_direction
-- ============================================================
CREATE OR REPLACE FUNCTION public.backfill_find_or_create_person(
  p_user_id text,
  p_channel text,
  p_handle text,
  p_display_name text,
  p_unipile_account_id text,
  p_direction text DEFAULT NULL
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
BEGIN
  SELECT i.id, i.person_id INTO v_identity_id, v_person_id
  FROM identities i
  JOIN persons p ON p.id = i.person_id
  WHERE i.channel = p_channel
    AND i.handle = p_handle
    AND p.user_id = p_user_id
  LIMIT 1;

  IF v_person_id IS NOT NULL THEN
    IF p_display_name IS NOT NULL AND p_display_name != 'Unknown' THEN
      UPDATE persons SET display_name = p_display_name, updated_at = now()
      WHERE id = v_person_id AND display_name = 'Unknown';
    END IF;
    RETURN json_build_object('person_id', v_person_id, 'identity_id', v_identity_id);
  END IF;

  v_status := CASE WHEN p_direction = 'inbound' THEN 'pending' ELSE 'approved' END;

  INSERT INTO persons (user_id, display_name, status)
  VALUES (p_user_id, p_display_name, v_status)
  RETURNING id INTO v_person_id;

  v_orphan_id := v_person_id;

  BEGIN
    INSERT INTO identities (person_id, channel, handle, display_name, unipile_account_id, user_id)
    VALUES (v_person_id, p_channel, p_handle, p_display_name, p_unipile_account_id, p_user_id)
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

-- ============================================================
-- UPDATE get_conversations — add p_status, p_circle_id, channels
-- ============================================================
DROP FUNCTION IF EXISTS public.get_conversations(text);

CREATE OR REPLACE FUNCTION public.get_conversations(
  p_user_id text,
  p_status text DEFAULT 'approved',
  p_circle_id uuid DEFAULT NULL
)
RETURNS TABLE (
  person_id uuid,
  display_name text,
  avatar_url text,
  notes text,
  ai_summary text,
  channels text[],
  last_message_id uuid,
  last_channel text,
  last_direction text,
  last_message_type text,
  last_body_text text,
  last_subject text,
  last_attachments jsonb,
  last_sender_name text,
  last_sent_at timestamptz,
  last_triage text,
  last_thread_id text,
  last_external_id text,
  last_seen boolean,
  last_delivered boolean,
  prev_inbound_body text,
  prev_inbound_sender text,
  unread_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (m.person_id)
      m.person_id,
      m.id AS last_message_id,
      m.channel AS last_channel,
      m.direction AS last_direction,
      m.message_type AS last_message_type,
      m.body_text AS last_body_text,
      m.subject AS last_subject,
      m.attachments AS last_attachments,
      m.sender_name AS last_sender_name,
      m.sent_at AS last_sent_at,
      m.triage AS last_triage,
      m.thread_id AS last_thread_id,
      m.external_id AS last_external_id,
      m.seen AS last_seen,
      m.delivered AS last_delivered
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.person_id IS NOT NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
    ORDER BY m.person_id, m.sent_at DESC
  ),
  counts AS (
    SELECT m.person_id, COUNT(*) AS unread_count
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.direction = 'inbound'
      AND m.read_at IS NULL
      AND m.hidden IS NOT TRUE
      AND m.deleted IS NOT TRUE
      AND m.person_id IS NOT NULL
    GROUP BY m.person_id
  )
  SELECT
    p.id AS person_id,
    p.display_name,
    p.avatar_url,
    p.notes,
    p.ai_summary,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = p.id) AS channels,
    l.last_message_id,
    l.last_channel,
    l.last_direction,
    l.last_message_type,
    l.last_body_text,
    l.last_subject,
    l.last_attachments,
    l.last_sender_name,
    l.last_sent_at,
    l.last_triage,
    l.last_thread_id,
    l.last_external_id,
    l.last_seen,
    l.last_delivered,
    NULL::text AS prev_inbound_body,
    NULL::text AS prev_inbound_sender,
    COALESCE(c.unread_count, 0) AS unread_count
  FROM latest l
  JOIN persons p ON p.id = l.person_id
  LEFT JOIN counts c ON c.person_id = l.person_id
  WHERE p.status = p_status
    AND (p_circle_id IS NULL OR EXISTS (
      SELECT 1 FROM circle_members cm
      WHERE cm.person_id = p.id AND cm.circle_id = p_circle_id
    ))
  ORDER BY l.last_sent_at DESC;
$$;

-- ============================================================
-- SCREENER RPCs
-- ============================================================
CREATE OR REPLACE FUNCTION public.approve_person(p_user_id text, p_person_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  UPDATE persons SET status = 'approved', updated_at = now()
  WHERE id = p_person_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_person(p_user_id text, p_person_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  UPDATE persons SET status = 'blocked', updated_at = now()
  WHERE id = p_person_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_pending_count(p_user_id text)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(*) FROM persons
  WHERE user_id = p_user_id AND status = 'pending';
$$;

-- ============================================================
-- MERGE RPCs
-- ============================================================
CREATE OR REPLACE FUNCTION public.merge_persons(
  p_user_id text,
  p_keep_id uuid,
  p_merge_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log_id uuid;
  v_name text;
  v_identities jsonb;
  v_msg_count integer;
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT display_name INTO v_name FROM persons WHERE id = p_merge_id AND user_id = p_user_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Person not found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = p_keep_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Keep person not found';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'channel', channel, 'handle', handle)), '[]'::jsonb)
  INTO v_identities
  FROM identities WHERE person_id = p_merge_id;

  SELECT COUNT(*) INTO v_msg_count FROM messages WHERE person_id = p_merge_id;

  INSERT INTO merge_log (user_id, keep_person_id, merged_person_id, merged_person_name, merged_identities, merged_message_count)
  VALUES (p_user_id, p_keep_id, p_merge_id, v_name, v_identities, v_msg_count)
  RETURNING id INTO v_log_id;

  UPDATE identities SET person_id = p_keep_id WHERE person_id = p_merge_id;
  UPDATE messages SET person_id = p_keep_id WHERE person_id = p_merge_id;
  UPDATE circle_members SET person_id = p_keep_id WHERE person_id = p_merge_id
    AND NOT EXISTS (SELECT 1 FROM circle_members cm2 WHERE cm2.circle_id = circle_members.circle_id AND cm2.person_id = p_keep_id);
  DELETE FROM circle_members WHERE person_id = p_merge_id;

  IF (SELECT status FROM persons WHERE id = p_merge_id) = 'approved' THEN
    UPDATE persons SET status = 'approved' WHERE id = p_keep_id;
  END IF;

  DELETE FROM persons WHERE id = p_merge_id;

  RETURN v_log_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_merge(p_user_id text, p_merge_log_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_log merge_log%ROWTYPE;
  v_new_person_id uuid;
  v_ident record;
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_log FROM merge_log
  WHERE id = p_merge_log_id AND user_id = p_user_id AND undone_at IS NULL;
  IF v_log.id IS NULL THEN
    RAISE EXCEPTION 'Merge log not found or already undone';
  END IF;

  INSERT INTO persons (user_id, display_name, status)
  VALUES (p_user_id, v_log.merged_person_name, 'approved')
  RETURNING id INTO v_new_person_id;

  FOR v_ident IN SELECT * FROM jsonb_to_recordset(v_log.merged_identities) AS x(id uuid, channel text, handle text)
  LOOP
    UPDATE identities SET person_id = v_new_person_id
    WHERE id = v_ident.id AND person_id = v_log.keep_person_id;
  END LOOP;

  UPDATE messages SET person_id = v_new_person_id
  WHERE person_id = v_log.keep_person_id
    AND identity_id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_log.merged_identities) j);

  UPDATE merge_log SET undone_at = now() WHERE id = p_merge_log_id;

  RETURN v_new_person_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dismiss_merge(p_user_id text, p_person_a uuid, p_person_b uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id != (auth.uid())::text THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  INSERT INTO merge_dismissed (person_a, person_b, user_id)
  VALUES (LEAST(p_person_a, p_person_b), GREATEST(p_person_a, p_person_b), p_user_id)
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_merge_suggestions(p_user_id text)
RETURNS TABLE (
  person_a_id uuid,
  person_a_name text,
  person_a_avatar text,
  person_a_channels text[],
  person_b_id uuid,
  person_b_name text,
  person_b_avatar text,
  person_b_channels text[],
  match_type text,
  match_detail text,
  score real
)
LANGUAGE sql
STABLE
AS $$
  WITH handle_matches AS (
    SELECT
      p1.id AS pa_id, p1.display_name AS pa_name, p1.avatar_url AS pa_avatar,
      p2.id AS pb_id, p2.display_name AS pb_name, p2.avatar_url AS pb_avatar,
      'identifier'::text AS mtype,
      i1.handle AS mdetail,
      1.0::real AS mscore
    FROM identities i1
    JOIN identities i2 ON lower(i1.handle) = lower(i2.handle) AND i1.channel != i2.channel AND i1.id < i2.id
    JOIN persons p1 ON i1.person_id = p1.id
    JOIN persons p2 ON i2.person_id = p2.id
    WHERE p1.id != p2.id AND p1.user_id = p_user_id AND p2.user_id = p_user_id
      AND p1.status != 'blocked' AND p2.status != 'blocked'
      AND NOT EXISTS (
        SELECT 1 FROM merge_dismissed md
        WHERE md.person_a = LEAST(p1.id, p2.id) AND md.person_b = GREATEST(p1.id, p2.id)
      )
  ),
  name_matches AS (
    SELECT
      p1.id AS pa_id, p1.display_name AS pa_name, p1.avatar_url AS pa_avatar,
      p2.id AS pb_id, p2.display_name AS pb_name, p2.avatar_url AS pb_avatar,
      'name'::text AS mtype,
      p1.display_name || ' / ' || p2.display_name AS mdetail,
      similarity(p1.display_name, p2.display_name)::real AS mscore
    FROM persons p1
    JOIN persons p2 ON p1.id < p2.id AND p1.user_id = p2.user_id
    WHERE p1.user_id = p_user_id
      AND p1.display_name IS NOT NULL AND p1.display_name != '' AND p1.display_name != 'Unknown'
      AND p2.display_name IS NOT NULL AND p2.display_name != '' AND p2.display_name != 'Unknown'
      AND similarity(p1.display_name, p2.display_name) > 0.4
      AND p1.status != 'blocked' AND p2.status != 'blocked'
      AND NOT EXISTS (
        SELECT 1 FROM merge_dismissed md
        WHERE md.person_a = LEAST(p1.id, p2.id) AND md.person_b = GREATEST(p1.id, p2.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM handle_matches hm
        WHERE (hm.pa_id = p1.id AND hm.pb_id = p2.id) OR (hm.pa_id = p2.id AND hm.pb_id = p1.id)
      )
  )
  SELECT
    pa_id, pa_name, pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pa_id),
    pb_id, pb_name, pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pb_id),
    mtype, mdetail, mscore
  FROM handle_matches
  UNION ALL
  SELECT
    pa_id, pa_name, pa_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pa_id),
    pb_id, pb_name, pb_avatar,
    (SELECT array_agg(DISTINCT i.channel) FROM identities i WHERE i.person_id = pb_id),
    mtype, mdetail, mscore
  FROM name_matches
  ORDER BY mscore DESC;
$$;
